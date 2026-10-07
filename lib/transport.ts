/* =========================================================================
 * Transport MQTT untuk browser.
 * - Menyambung ke broker publik lewat WSS (tanpa akun, tanpa database).
 * - Kalau satu broker mati/diblokir, otomatis pindah ke broker berikutnya.
 * - Antarmuka `Transport` dibuat generik supaya mudah diganti (mis. Pusher,
 *   Ably, atau WebSocket milik sendiri) tanpa mengubah logika permainan.
 * ========================================================================= */
import { Broker, DEFAULT_BROKERS, Envelope, TOPIC_PREFIX } from './protocol';

export type NetStatus = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline';
export interface NetInfo { status: NetStatus; broker?: string; detail?: string }

export interface Transport {
  connect(): void;
  close(): void;
  publish(env: Envelope): boolean;
  onMessage(cb: (env: Envelope) => void): () => void;
  onStatus(cb: (info: NetInfo) => void): () => void;
  readonly topic: string;
}

/** Broker yang dipakai: bawaan, atau timpa lewat localStorage (untuk pengujian). */
export function resolveBrokers(): Broker[] {
  if (typeof window === 'undefined') return DEFAULT_BROKERS;
  try {
    const raw = window.localStorage.getItem('catur.brokers');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length && parsed.every((b: any) => b && b.url)) {
        return parsed.map((b: any, i: number) => ({ id: b.id || 'custom' + i, label: b.label || b.url, url: b.url }));
      }
    }
    const single = window.localStorage.getItem('catur.broker');
    if (single) return [{ id: 'custom', label: 'Kustom', url: single }, ...DEFAULT_BROKERS];
  } catch { /* abaikan */ }
  return DEFAULT_BROKERS;
}

export class MqttTransport implements Transport {
  readonly topic: string;
  private roomId: string;
  private pid: string;
  private brokers: Broker[];
  private client: any = null;
  private msgCbs: ((env: Envelope) => void)[] = [];
  private statusCbs: ((info: NetInfo) => void)[] = [];
  private brokerIdx = 0;
  private attempts = 0;
  private closed = false;
  private retryTimer: any = null;
  private online = false;

  constructor(roomId: string, pid: string) {
    this.roomId = roomId;
    this.pid = pid;
    this.topic = `${TOPIC_PREFIX}/${roomId}`;
    this.brokers = resolveBrokers();
  }

  onMessage(cb: (env: Envelope) => void) { this.msgCbs.push(cb); return () => { this.msgCbs = this.msgCbs.filter(f => f !== cb); }; }
  onStatus(cb: (info: NetInfo) => void) { this.statusCbs.push(cb); return () => { this.statusCbs = this.statusCbs.filter(f => f !== cb); }; }

  private setStatus(status: NetStatus, detail?: string) {
    const broker = this.brokers[this.brokerIdx]?.label;
    for (const cb of this.statusCbs) cb({ status, broker, detail });
  }

  connect() {
    this.closed = false;
    this.statusCbs.length && this.setStatus('connecting');
    this.openNext();
  }

  private async openNext() {
    if (this.closed) return;
    const broker = this.brokers[this.brokerIdx % this.brokers.length];
    let mqtt: any;
    try {
      const mod: any = await import('mqtt');
      mqtt = mod.default || mod;
    } catch (e: any) {
      this.setStatus('offline', 'Pustaka MQTT gagal dimuat');
      return;
    }
    if (this.closed) return;
    this.setStatus(this.attempts === 0 ? 'connecting' : 'reconnecting', 'Menghubungi ' + broker.label);

    let settled = false;
    let client: any;
    const giveUp = () => {
      if (settled) return;
      settled = true;
      try { client && client.end(true); } catch { /* abaikan */ }
      this.brokerIdx++;
      this.attempts++;
      if (this.attempts > this.brokers.length * 3) {
        this.setStatus('offline', 'Semua broker gagal dihubungi');
        this.retryTimer = setTimeout(() => { this.attempts = 0; this.openNext(); }, 8000);
      } else {
        this.retryTimer = setTimeout(() => this.openNext(), Math.min(1500 * (this.attempts % 3 + 1), 5000));
      }
    };
    const timeout = setTimeout(giveUp, 10000);

    try {
      client = mqtt.connect(broker.url, {
        clientId: 'catur-' + this.pid.slice(0, 10) + '-' + Math.random().toString(16).slice(2, 8),
        clean: true,
        connectTimeout: 9000,
        reconnectPeriod: 0,          // reconnect ditangani sendiri agar bisa pindah broker
        keepalive: 30,
        protocolVersion: 4,
      });
      this.client = client;
    } catch (e: any) {
      clearTimeout(timeout);
      return giveUp();
    }

    client.on('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      this.attempts = 0;
      this.online = true;
      client.subscribe(this.topic, { qos: 1 }, (err: any) => {
        if (err) { this.setStatus('reconnecting', 'Gagal berlangganan topik'); return; }
        this.setStatus('online');
      });
    });

    client.on('message', (_topic: string, payload: Uint8Array) => {
      let env: Envelope;
      try { env = JSON.parse(payload.toString()); } catch { return; }
      if (!env || env.v !== 1 || env.from === this.pid) return;   // abaikan gema pesan sendiri
      for (const cb of this.msgCbs) cb(env);
    });

    client.on('close', () => {
      if (this.closed) return;
      if (!settled) return;                 // sudah ditangani giveUp/timeout
      this.online = false;
      this.attempts++;
      this.setStatus('reconnecting', 'Koneksi terputus');
      this.brokerIdx++;                     // coba broker berikutnya
      this.retryTimer = setTimeout(() => this.openNext(), Math.min(1200 * this.attempts, 6000));
    });

    client.on('error', () => {
      if (this.closed) return;
      if (!settled) { clearTimeout(timeout); giveUp(); }
    });
  }

  publish(env: Envelope): boolean {
    if (!this.client || !this.online) return false;
    try { this.client.publish(this.topic, JSON.stringify(env), { qos: 1 }); return true; }
    catch { return false; }
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    try { this.client && this.client.end(true); } catch { /* abaikan */ }
    this.client = null;
    this.online = false;
  }
}

/* -------------------------------------------------------------------------
 * Transport dalam memori — dipakai tes unit (dua Room disambung langsung)
 * dan mode "latihan lokal" tanpa jaringan.
 * ----------------------------------------------------------------------- */
export class MemoryTransport implements Transport {
  readonly topic: string;
  peers: MemoryTransport[] = [];
  /** Untuk pengujian: bila true, pesan masuk diabaikan (mensimulasikan jaringan putus). */
  receiveBlock = false;
  private msgCbs: ((env: Envelope) => void)[] = [];
  private statusCbs: ((info: NetInfo) => void)[] = [];
  latency = 0;

  constructor(topic = 'mem') { this.topic = topic; }

  link(other: MemoryTransport) { this.peers.push(other); other.peers.push(this); }
  onMessage(cb: (env: Envelope) => void) { this.msgCbs.push(cb); return () => { this.msgCbs = this.msgCbs.filter(f => f !== cb); }; }
  onStatus(cb: (info: NetInfo) => void) { this.statusCbs.push(cb); return () => { this.statusCbs = this.statusCbs.filter(f => f !== cb); }; }
  connect() { for (const cb of this.statusCbs) cb({ status: 'online', broker: 'memori' }); }
  close() { this.peers = []; for (const cb of this.statusCbs) cb({ status: 'offline' }); }
  publish(env: Envelope): boolean {
    const deliver = () => {
      for (const p of this.peers) { if (p.receiveBlock) continue; for (const cb of p.msgCbs) cb(JSON.parse(JSON.stringify(env))); }
    };
    if (this.latency > 0) setTimeout(deliver, this.latency); else queueMicrotask(deliver);
    return true;
  }
}
