/* =========================================================================
 * Protokol permainan — semua pesan lewat satu topik MQTT publik:
 *     catur/v1/<kode-room>
 *
 * Kenapa MQTT? Karena Vercel (serverless) tidak bisa menyimpan state di memori
 * dan tidak mendukung WebSocket. Broker publik jadi "pipa" realtime gratis,
 * tanpa akun, tanpa database. Aturan permainan divalidasi di kedua klien
 * secara deterministik (mesin catur yang sama di kedua device).
 * ========================================================================= */

export const PROTOCOL_VERSION = 1;
export const TOPIC_PREFIX = 'catur/v1';

/** Broker publik (gratis, tanpa akun). Bisa ditimpa lewat Pengaturan. */
export interface Broker { id: string; label: string; url: string }
export const DEFAULT_BROKERS: Broker[] = [
  { id: 'emqx', label: 'EMQX', url: 'wss://broker.emqx.io:8084/mqtt' },
  { id: 'hivemq', label: 'HiveMQ', url: 'wss://broker.hivemq.com:8884/mqtt' },
];

/** Kontrol waktu: 10 menit + 2 detik per langkah. */
export const BASE_TIME = 10 * 60 * 1000;
export const INCREMENT = 2 * 1000;

/** Detak kehadiran & ambang dianggap terputus. */
export const PRESENCE_MS = 8 * 1000;
export const ABSENT_MS = 26 * 1000;

/** Panjang kode room (karakter acak, sekaligus kunci topik). */
export const ROOM_CODE_LEN = 8;

export type Side = 'w' | 'b';
export type Role = Side | 'spectator';

export interface GameResult {
  type: 'checkmate' | 'stalemate' | 'draw' | 'resign' | 'timeout' | 'draw-agreed' | 'repetition' | 'insufficient';
  winner: Side | null;
  reason: string;
}

export interface ClockBase { w: number; b: number }

export interface Envelope {
  v: number;          // versi protokol
  id: string;         // id unik pesan (untuk anti-duplikat)
  kind: string;       // jenis pesan
  from: string;       // pid pengirim
  to?: string;        // pid tujuan (kosong = semua)
  room: string;
  t: number;          // waktu kirim (ms, jam pengirim — hanya informatif)
  data?: any;
}

/** Jenis-jenis pesan beserta data yang dibawa. */
export type Kind =
  | 'hello'             // { name, want: 'w'|'b'|'auto' }  — memperkenalkan diri
  | 'want'              // { side }                          — klaim kursi
  | 'seats'             // { w: pid|null, b: pid|null }      — hasil kursi (sticky)
  | 'welcome'           // { to, snapshot }                  — jawaban untuk pendatang
  | 'snapshot'          // { to?, matchNo, seats, players, history, clock, result, drawOffer, rematchVotes, chatTail }
  | 'snapshot-request'  // {}                                — minta sinkronisasi ulang
  | 'move'              // { matchNo, ply, by, from, to, promo }
  | 'chat'              // { text }
  | 'presence'          // { name }
  | 'draw-offer'        // {}
  | 'draw-accept'       // {}
  | 'draw-decline'      // {}
  | 'resign'            // {}
  | 'rematch-vote'      // { matchNo }
  | 'leave'             // {}  — pamit (menutup tab)
  | 'timeout';          // { matchNo, loser }

export function isValidRoomCode(code: string): boolean {
  return typeof code === 'string' && /^[a-z0-9]{4,24}$/.test(code);
}

export function makeRoomCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789'; // tanpa huruf/angka membingungkan
  let out = '';
  const rnd = new Uint8Array(ROOM_CODE_LEN);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(rnd);
  for (let i = 0; i < ROOM_CODE_LEN; i++) {
    const r = rnd[i] || Math.floor(Math.random() * 256);
    out += alphabet[r % alphabet.length];
  }
  return out;
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}
