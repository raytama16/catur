/* =========================================================================
 * Room — mesin state permainan yang berjalan di SISI KLIEN.
 *
 * Karena Vercel tidak bisa menyimpan state, kedua device adalah "server" untuk
 * dirinya sendiri. Sinkronisasi dijaga dengan tiga aturan sederhana:
 *
 *  1. DETERMINISTIK — kedua device memakai mesin catur yang sama, jadi
 *     rangkaian langkah yang sama selalu menghasilkan posisi yang sama.
 *  2. PEMILIK KURSI (sticky) — kursi Putih/Hitam menempel pada pid; tidak
 *     berpindah walau halaman dimuat ulang.
 *  3. OTORITAS & SINKRON ULANG — bila ada ketidakcocokan (ada langkah yang
 *     terlewat), klien meminta `snapshot` dari pemegang kursi yang hadir,
 *     lalu memutar ulang riwayat langkah dari posisi awal.
 * ========================================================================= */
import * as E from './chess';
import {
  ABSENT_MS, BASE_TIME, Envelope, GameResult, INCREMENT, Kind, PRESENCE_MS,
  GameResult as Result, Role, Side, newId,
} from './protocol';
import type { NetInfo, NetStatus, Transport } from './transport';

export interface RoomOptions {
  roomId: string;
  pid: string;
  name: string;
  transport: Transport;
  preferSide?: 'w' | 'b' | 'auto';
  now?: () => number;
}

export interface PlayerRec {
  pid: string;
  name: string;
  want: 'w' | 'b' | 'auto';
  wantTakeover?: boolean;
  firstSeen: number;
  lastSeen: number;
}

export interface SeatInfo { pid: string; name: string; present: boolean }

export interface HistoryEntry { from: number; to: number; promo: string | null; san: string; color: Side }
export interface ChatEntry { id: string; pid: string; name: string; text: string; at: number }
export interface ClockView { w: number; b: number; running: Side | null }

export interface PublicState {
  roomId: string;
  myPid: string;
  myName: string;
  net: NetStatus;
  broker: string | null;
  netDetail: string | null;
  fen: string;
  turn: Side;
  inCheck: boolean;
  status: Result | { type: 'playing'; winner: null; reason: string | null };
  seats: { w: SeatInfo | null; b: SeatInfo | null };
  myRole: Role;
  clock: ClockView;
  history: HistoryEntry[];
  chat: ChatEntry[];
  drawOffer: Side | null;
  rematch: { mine: boolean; theirs: boolean };
  spectators: number;
  opponentName: string | null;
  matchNo: number;
  started: boolean;
  freeSeats: Side[];
  lastMove: HistoryEntry | null;
  lastError: string | null;
}

const seatOrder: Side[] = ['w', 'b'];
const oppSide = (s: Side): Side => (s === 'w' ? 'b' : 'w');

export class Room {
  readonly roomId: string;
  readonly pid: string;
  private name: string;
  private transport: Transport;
  private now: () => number;

  private engine: E.ChessState = E.parseFen(E.START_FEN);
  private history: HistoryEntry[] = [];
  private repCounts = new Map<string, number>();
  private seatsPid: { w: string | null; b: string | null } = { w: null, b: null };
  private players = new Map<string, PlayerRec>();
  private chatLog: ChatEntry[] = [];
  private clockBase = { w: BASE_TIME, b: BASE_TIME };
  private turnStartedAt: number | null = null;
  private startedAt: number | null = null;
  private result: Result | null = null;
  private drawOffer: Side | null = null;
  private rematchVotes = new Set<string>();
  private matchNo = 1;
  private seenIds = new Set<string>();
  private preferSide: 'w' | 'b' | 'auto';

  private net: NetStatus = 'idle';
  private netBroker: string | null = null;
  private netDetail: string | null = null;
  private lastError: string | null = null;
  private presentCache: Record<Side, boolean> = { w: false, b: false };

  private unsub: (() => void)[] = [];
  private listeners = new Set<() => void>();
  private snapshot: PublicState;
  private presenceTimer: any = null;
  private tickTimer: any = null;
  private soloTimer: any = null;
  private closed = false;

  constructor(opts: RoomOptions) {
    this.roomId = opts.roomId;
    this.pid = opts.pid;
    this.name = opts.name;
    this.transport = opts.transport;
    this.preferSide = opts.preferSide || 'auto';
    this.now = opts.now || (() => Date.now());
    this.players.set(this.pid, {
      pid: this.pid, name: this.name, want: this.preferSide === 'auto' ? 'auto' : this.preferSide,
      firstSeen: this.now(), lastSeen: this.now(),
    });
    this.snapshot = this.buildState();
    this.unsub.push(this.transport.onMessage(env => this.onMessage(env)));
    this.unsub.push(this.transport.onStatus(info => this.onStatus(info)));
  }

  /* ---------------- siklus hidup ---------------- */
  connect() {
    this.transport.connect();
    this.presenceTimer = setInterval(() => this.tickAll(), 1000);
  }

  close() {
    this.closed = true;
    clearInterval(this.presenceTimer);
    clearInterval(this.tickTimer);
    clearTimeout(this.soloTimer);
    for (const t of this.welcomeTimers.values()) clearTimeout(t);
    this.welcomeTimers.clear();
    this.unsub.forEach(f => f());
    this.transport.close();
  }

  subscribe(cb: () => void) {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }
  getState(): PublicState { return this.snapshot; }
  private emit() {
    this.snapshot = this.buildState();
    for (const cb of this.listeners) cb();
  }

  setName(name: string) {
    this.name = name;
    const me = this.players.get(this.pid);
    if (me) me.name = name;
    this.publish('presence', { name });
    this.emit();
  }

  /* ---------------- jaringan ---------------- */
  private onStatus(info: NetInfo) {
    const wasOffline = this.net !== 'online';
    this.net = info.status;
    this.netBroker = info.broker || null;
    this.netDetail = info.detail || null;
    if (info.status === 'online' && wasOffline) { this.announce(); this.resolveSeats(); this.maybeStartGame(); }
    this.emit();
  }

  /** Perkenalkan diri begitu tersambung ke broker. */
  private announce() {
    this.publish('hello', { name: this.name, want: this.me?.want || 'auto', ...this.digest() });
    // Kalau sendirian sebentar lagi, ambil kursi Putih (perilaku "pembuat room")
    clearTimeout(this.soloTimer);
    this.soloTimer = setTimeout(() => {
      const others = [...this.players.values()].filter(p => p.pid !== this.pid && this.isPresentRec(p, this.now()));
      const takAdaKabar = !this.learnedSeats && !this.seatsPid.w && !this.seatsPid.b;
      if (others.length === 0 && takAdaKabar) {      // benar-benar sendirian di room baru
        const me = this.players.get(this.pid)!;
        me.want = 'w';
        this.publish('want', { side: 'w' });
        this.emit();
      }
    }, 2600);
  }

  private dbg(...args: any[]) {
    if (typeof process !== 'undefined' && process.env && process.env.CATUR_DEBUG) {
      console.log('   [' + this.pid + ']', ...args);
    }
  }

  private publish(kind: Kind, data?: any, to?: string) {
    const env: Envelope = {
      v: 1, id: newId(), kind, from: this.pid, room: this.roomId, t: this.now(),
      ...(to ? { to } : {}), ...(data !== undefined ? { data } : {}),
    };
    this.transport.publish(env);
    this.dbg('KIRIM', kind, to ? '→ ' + to : '(semua)');
  }

  private get me(): PlayerRec | undefined { return this.players.get(this.pid); }

  private remember(env: Envelope, info: { name?: string; want?: 'w' | 'b' | 'auto'; takeover?: boolean }) {
    const t = this.now();
    let rec = this.players.get(env.from);
    if (!rec) {
      rec = { pid: env.from, name: info.name || 'Pemain', want: info.want || 'auto', firstSeen: t, lastSeen: t };
      this.players.set(env.from, rec);
    }
    rec.lastSeen = t;
    if (info.name) rec.name = info.name;
    if (info.want) rec.want = info.want;
    if (info.takeover) rec.wantTakeover = true;
  }

  private onMessage(env: Envelope) {
    if (this.closed) return;
    if (env.room !== this.roomId) return;
    if (env.to && env.to !== this.pid) return;
    if (this.seenIds.has(env.id)) return;
    this.seenIds.add(env.id);
    if (this.seenIds.size > 800) this.seenIds = new Set([...this.seenIds].slice(-400));

    const t = this.now();
    this.dbg('TERIMA', env.kind, 'dari', env.from, env.data && env.data.ply !== undefined ? 'ply=' + env.data.ply : '');
    switch (env.kind as Kind) {
      case 'hello': {
        this.remember(env, { name: env.data?.name, want: env.data?.want });
        this.resolveSeats();
        if (this.shouldAnswerWelcome(env.from, env.data?.ply)) this.sendWelcome(env.from);
        else this.publish('presence', { name: this.name, ...this.digest() });  // perkenalkan diri
        this.reconcileDigest(env);
        break;
      }
      case 'presence': {
        this.remember(env, { name: env.data?.name, want: env.data?.want });
        this.resolveSeats();
        this.reconcileDigest(env);
        break;
      }
      case 'want': {
        this.remember(env, { want: env.data?.side, takeover: !!env.data?.takeover });
        if (env.data?.takeover) this.handleTakeover(env.from, env.data?.side);
        this.resolveSeats();
        break;
      }
      case 'seats': {
        this.remember(env, {});
        this.learnedSeats = true;
        this.mergeSeats(env.data?.w ?? null, env.data?.b ?? null);
        break;
      }
      case 'welcome':
      case 'snapshot': {
        this.remember(env, { name: env.data?.players?.find?.((p: any) => p.pid === env.from)?.name });
        this.learnedSeats = true;
        this.applySnapshot(env.data);
        break;
      }
      case 'snapshot-request': {
        this.remember(env, {});
        if (this.shouldAnswerWelcome(env.from, env.data?.ply)) this.sendWelcome(env.from, true);
        break;
      }
      case 'move': this.onRemoteMove(env); break;
      case 'chat': {
        this.remember(env, {});
        this.pushChat({ id: env.id, pid: env.from, name: this.players.get(env.from)?.name || 'Pemain', text: String(env.data?.text || '').slice(0, 300), at: t });
        break;
      }
      case 'draw-offer': {
        const s = this.sideOfPid(env.from);
        if (s && !this.result) { this.drawOffer = s; this.emit(); }
        break;
      }
      case 'draw-accept': {
        if (this.drawOffer && this.drawOffer !== this.sideOfPid(env.from)) {
          this.setResult({ type: 'draw-agreed', winner: null, reason: 'damai disepakati' });
        }
        break;
      }
      case 'draw-decline': this.drawOffer = null; this.emit(); break;
      case 'resign': {
        const s = this.sideOfPid(env.from);
        if (s && !this.result) {
          this.setResult({ type: 'resign', winner: oppSide(s), reason: (s === 'w' ? 'Putih' : 'Hitam') + ' menyerah' });
        }
        break;
      }
      case 'timeout': {
        if (env.data?.matchNo && env.data.matchNo !== this.matchNo) break;
        const loser = this.sideOfPid(env.data?.loser);
        if (loser && !this.result) {
          this.clockBase[loser] = 0;
          this.setResult({ type: 'timeout', winner: oppSide(loser), reason: (loser === 'w' ? 'Putih' : 'Hitam') + ' kehabisan waktu' });
        }
        break;
      }
      case 'rematch-vote': {
        if (env.data?.matchNo !== this.matchNo) break;
        if (!this.sideOfPid(env.from)) break;
        this.rematchVotes.add(env.from);
        this.maybeStartRematch();
        this.emit();
        break;
      }
      case 'leave': {
        const rec = this.players.get(env.from);
        if (rec) { rec.lastSeen = 0; rec.want = 'auto'; }
        break;
      }
    }
    this.tickAll();
    this.emit();
  }

  /* ---------------- kursi ---------------- */
  private sideOfPid(pid: string): Side | null {
    if (!pid) return null;
    if (this.seatsPid.w === pid) return 'w';
    if (this.seatsPid.b === pid) return 'b';
    return null;
  }
  get myRole(): Role { return this.sideOfPid(this.pid) || 'spectator'; }

  private isPresentRec(rec: PlayerRec, t: number) { return t - rec.lastSeen < ABSENT_MS && rec.lastSeen > 0; }
  private isSidePresent(side: Side, t = this.now()): boolean {
    const pid = this.seatsPid[side];
    if (!pid) return false;
    const rec = this.players.get(pid);
    return !!rec && this.isPresentRec(rec, t);
  }

  /** Isi kursi kosong dari klaim yang terlihat — hasilnya deterministik. */
  private resolveSeats() {
    const t = this.now();
    const held: { w: string | null; b: string | null } = {
      w: this.seatsPid.w && this.players.has(this.seatsPid.w) ? this.seatsPid.w : null,
      b: this.seatsPid.b && this.players.has(this.seatsPid.b) ? this.seatsPid.b : null,
    };
    if (held.w && held.w === held.b) held.b = null;

    const byPid = (a: PlayerRec, b: PlayerRec) => (a.pid < b.pid ? -1 : 1);
    const claimable = [...this.players.values()].filter(p => p.pid !== held.w && p.pid !== held.b);

    // 1) klaim eksplisit ("saya mau Putih/Hitam") selalu dihormati lebih dulu
    for (const side of seatOrder) {
      if (held[side]) continue;
      const explicit = claimable.filter(p => p.want === side).sort(byPid)[0];
      if (explicit) held[side] = explicit.pid;
    }

    // 2) sisanya diisi otomatis HANYA bila kita punya dasar untuk itu:
    //    sudah mendengar kabar kursi dari jaringan, atau memang ada ≥2 pemain.
    //    Tanpa dasar ini, klien yang baru masuk akan menunggu (tidak menyerobot kursi).
    const basis = this.learnedSeats || this.players.size > 1;
    if (basis) {
      for (const p of claimable.slice().sort(byPid)) {
        if (p.pid === held.w || p.pid === held.b) continue;
        if (!held.w) held.w = p.pid;
        else if (!held.b) held.b = p.pid;
      }
    }

    const changed = held.w !== this.seatsPid.w || held.b !== this.seatsPid.b;
    this.seatsPid = held;
    if (changed) {
      this.publish('seats', { w: held.w, b: held.b });
      this.maybeStartGame();
    }
  }

  private mergeSeats(w: string | null, b: string | null) {
    for (const [side, pid] of [['w', w], ['b', b]] as [Side, string | null][]) {
      if (!pid) continue;
      const cur = this.seatsPid[side];
      if (cur && cur !== pid) {
        this.seatsPid[side] = cur < pid ? cur : pid;   // konflik → pid terkecil menang (sepakat di dua sisi)
      } else {
        this.seatsPid[side] = pid;
      }
    }
    if (this.seatsPid.w && this.seatsPid.w === this.seatsPid.b) this.seatsPid.b = null;
    this.resolveSeats();
  }

  private handleTakeover(pid: string, side: Side) {
    if (!side) return;
    const holder = this.seatsPid[side];
    if (!holder) return;
    const rec = this.players.get(holder);
    const t = this.now();
    if (rec && !this.isPresentRec(rec, t) && t - rec.lastSeen > ABSENT_MS * 2) {
      this.seatsPid[side] = pid;
      this.rematchVotes.clear();
      this.publish('seats', { ...this.seatsPid });
    }
  }

  /** Ambil kursi kosong (dipakai penonton saat pemegang kursi tidak kembali). */
  claimSeat(side: Side) {
    if (this.sideOfPid(this.pid)) return;
    this.publish('want', { side, takeover: true });
    const holder = this.seatsPid[side];
    const rec = holder ? this.players.get(holder) : null;
    if (!holder || (rec && this.now() - rec.lastSeen > ABSENT_MS * 2)) {
      this.seatsPid[side] = this.pid;
      const meRec = this.players.get(this.pid)!;
      meRec.want = side;
      this.publish('seats', { ...this.seatsPid });
    }
    this.emit();
  }

  private maybeStartGame() {
    if (this.startedAt) return;
    if (this.seatsPid.w && this.seatsPid.b && this.net === 'online') {
      this.startedAt = this.now();
      this.turnStartedAt = this.now();
    }
  }

  /* ---------------- sinkronisasi ---------------- */
  private amAuthority(): boolean {
    const t = this.now();
    if (this.seatsPid.w === this.pid && this.isSidePresent('w', t)) return true;
    if (!this.isSidePresent('w', t) && this.seatsPid.b === this.pid && this.isSidePresent('b', t)) return true;
    return false;
  }

  private shouldAnswerWelcome(askerPid: string, askerPly?: number): boolean {
    if (askerPid === this.pid) return false;
    if (!this.sideOfPid(this.pid)) return false;      // penonton tidak menjawab
    const rec = this.players.get(askerPid);
    const pendatangBaru = !!rec && this.now() - rec.firstSeen < 6000;
    if (pendatangBaru) return true;                   // pemain baru selalu dibantu
    if (this.result) return true;                     // permainan sudah selesai: kirim hasil
    if (typeof askerPly !== 'number') return true;
    return askerPly < this.history.length;            // atau kalau dia memang tertinggal
  }

  private snapshotPayload() {
    return {
      matchNo: this.matchNo,
      seats: { ...this.seatsPid },
      players: [...this.players.values()].map(p => ({ pid: p.pid, name: p.name })),
      history: this.history.map(h => ({ from: h.from, to: h.to, promo: h.promo })),
      clock: { ...this.clockBase },
      result: this.result,
      drawOffer: this.drawOffer,
      rematchVotes: [...this.rematchVotes],
      chatTail: this.chatLog.slice(-40),
      startedAt: this.startedAt,
    };
  }

  private sendWelcome(to: string, isResync = false) {
    // Cegah badai snapshot: pesan berikutnya DITUNDA, bukan dibuang.
    const t = this.now();
    const wait = Math.max(0, 700 - (t - this.lastWelcomeAt));
    const key = to + ':' + (isResync ? 's' : 'w');
    clearTimeout(this.welcomeTimers.get(key));
    const fire = () => {
      this.welcomeTimers.delete(key);
      this.lastWelcomeAt = this.now();
      this.publish(isResync ? 'snapshot' : 'welcome', { to, snapshot: this.snapshotPayload() }, to);
    };
    if (wait === 0) fire();
    else this.welcomeTimers.set(key, setTimeout(fire, wait));
  }
  private lastWelcomeAt = 0;
  private welcomeTimers = new Map<string, any>();
  /** Sudah pernah menerima informasi kursi dari pemain lain? */
  private learnedSeats = false;

  requestResync() {
    const t = this.now();
    if (t - this.lastResyncAt < 1500) return;      // jangan membanjiri jaringan
    this.lastResyncAt = t;
    this.publish('snapshot-request', { ply: this.history.length, matchNo: this.matchNo });
  }
  private lastResyncAt = 0;

  /** Ringkasan kecil keadaan kita — disisipkan ke tiap detak kehadiran. */
  private digest() {
    return { matchNo: this.matchNo, ply: this.history.length, hasResult: !!this.result };
  }

  /** Bandingkan ringkasan lawan dengan milik kita → minta/beri sinkronisasi. */
  private reconcileDigest(env: Envelope) {
    const d = env.data || {};
    if (d.matchNo !== this.matchNo) return;
    if (typeof d.ply !== 'number') return;
    if (d.ply > this.history.length) this.requestResync();
    else if (d.ply < this.history.length && this.sideOfPid(this.pid)) this.sendWelcome(env.from, true);
  }

  private applySnapshot(data: any) {
    const snap = data?.snapshot || data;
    if (!snap || !Array.isArray(snap.history)) { this.dbg('snapshot TIDAK valid'); return; }
    if ((snap.matchNo || 1) < this.matchNo) { this.dbg('snapshot usang, dibuang'); return; }
    if ((snap.matchNo || 1) === this.matchNo && snap.history.length < this.history.length) { this.dbg('snapshot lebih pendek, dibuang'); return; }

    // putar ulang riwayat dari posisi awal → pasti konsisten
    const st = E.parseFen(E.START_FEN);
    const hist: HistoryEntry[] = [];
    for (const m of snap.history) {
      const mv = E.findMove(st, { from: m.from, to: m.to, promo: m.promo || undefined });
      if (!mv) { this.dbg('replay gagal di langkah', JSON.stringify(m)); this.requestResync(); return; }
      const san = E.moveToSan(st, mv);
      const color = E.colorOf(st.board[mv.from]!);
      E.makeMove(st, mv);
      hist.push({ from: mv.from, to: mv.to, promo: mv.promo || null, san, color });
    }
    this.engine = st;
    this.history = hist;
    this.repCounts.clear();
    {
      const st2 = E.parseFen(E.START_FEN);
      this.repCounts.set(E.fenKey(st2), 1);
      for (const h of hist) {
        const mv = E.findMove(st2, { from: h.from, to: h.to, promo: h.promo || undefined })!;
        E.makeMove(st2, mv);
        const k = E.fenKey(st2);
        this.repCounts.set(k, (this.repCounts.get(k) || 0) + 1);
      }
    }
    if (snap.seats) {
      this.seatsPid = { w: snap.seats.w || null, b: snap.seats.b || null };
      const mine = this.sideOfPid(this.pid);
      const rec = this.players.get(this.pid);
      if (mine && rec) rec.want = mine;              // jangan klaim ulang kursi lain
    }
    for (const p of snap.players || []) {
      const rec = this.players.get(p.pid);
      if (rec) rec.name = p.name;
      else this.players.set(p.pid, { pid: p.pid, name: p.name, want: 'auto', firstSeen: this.now(), lastSeen: this.now() });
    }
    if (snap.clock) this.clockBase = { w: snap.clock.w, b: snap.clock.b };
    if (typeof snap.startedAt === 'number') this.startedAt = snap.startedAt;
    this.turnStartedAt = this.now();
    this.drawOffer = snap.drawOffer ?? null;
    this.rematchVotes = new Set(snap.rematchVotes || []);
    this.result = snap.result || null;
    this.matchNo = snap.matchNo || this.matchNo;
    if (Array.isArray(snap.chatTail)) {
      const known = new Set(this.chatLog.map(c => c.id));
      for (const c of snap.chatTail) if (!known.has(c.id)) this.chatLog.push(c);
      this.chatLog = this.chatLog.slice(-200);
    }
    this.recomputeResult();
    this.maybeStartGame();
    this.emit();
  }

  /* ---------------- langkah ---------------- */
  /** Papan mungkin tertinggal — minta sinkronisasi sekarang (dibatasi frekuensi). */
  nudge() {
    if (this.net !== 'online') return;
    this.requestResync();
    const me = this.players.get(this.pid);
    if (me) { me.lastSeen = this.now(); }
    this.publish('presence', { name: this.name, want: me?.want || 'auto', ...this.digest() });
  }

  legalTargets(from: number): number[] {
    if (!this.canMoveNow()) return [];
    return E.legalMoves(this.engine).filter(m => m.from === from).map(m => m.to);
  }
  legalMovesList(): E.Move[] {
    if (!this.canMoveNow()) return [];
    return E.legalMoves(this.engine);
  }
  isPromotion(from: number, to: number): boolean {
    return E.legalMoves(this.engine).some(m => m.from === from && m.to === to && !!m.promo);
  }
  canMoveNow(): boolean {
    const role = this.myRole;
    return !this.result && !!this.startedAt && (role === 'w' || role === 'b') && this.engine.turn === role;
  }

  move(from: number, to: number, promo?: string): { ok: boolean; error?: string } {
    if (!this.canMoveNow()) return { ok: false, error: 'Bukan giliranmu.' };
    const mv = E.findMove(this.engine, { from, to, promo });
    if (!mv) return { ok: false, error: 'Langkah tidak legal.' };
    const t = this.now();
    const ply = this.history.length;
    this.applyMovePly(mv, this.pid, t);
    this.publish('move', { matchNo: this.matchNo, ply, by: this.pid, from: mv.from, to: mv.to, promo: mv.promo || null });
    this.tickAll();
    this.emit();
    return { ok: true };
  }

  private onRemoteMove(env: Envelope) {
    const d = env.data || {};
    if (d.matchNo !== this.matchNo) return;
    if (d.by === this.pid) return;
    if (d.ply !== this.history.length) {
      if (d.ply > this.history.length) this.requestResync();   // ada langkah terlewat
      return;
    }
    const side = this.sideOfPid(d.by);
    if (!side || side !== this.engine.turn) { this.requestResync(); return; }
    const mv = E.findMove(this.engine, { from: d.from, to: d.to, promo: d.promo || undefined });
    if (!mv) { this.requestResync(); return; }
    this.applyMovePly(mv, d.by, this.now());
  }

  private applyMovePly(mv: E.Move, moverPid: string, t: number) {
    const side = this.sideOfPid(moverPid);
    if (!side) return;
    const rem = Math.max(0, this.clockView(t)[side]);
    this.clockBase[side] = rem + INCREMENT;
    const piece = this.engine.board[mv.from]!;
    const san = E.moveToSan(this.engine, mv);
    E.makeMove(this.engine, mv);
    this.history.push({ from: mv.from, to: mv.to, promo: mv.promo || null, san, color: side as Side });
    const key = E.fenKey(this.engine);
    this.repCounts.set(key, (this.repCounts.get(key) || 0) + 1);
    this.turnStartedAt = t;
    this.drawOffer = null;
    this.recomputeResult();
    void piece;
  }

  private recomputeResult() {
    const st = E.getStatus(this.engine);
    if (st.type === 'checkmate') { this.setResult({ type: 'checkmate', winner: st.winner, reason: 'skakmat' }, true); return; }
    if (st.type === 'stalemate') { this.setResult({ type: 'stalemate', winner: null, reason: 'stalemate' }, true); return; }
    if (st.type === 'draw') { this.setResult({ type: 'draw', winner: null, reason: st.reason }, true); return; }
    const key = E.fenKey(this.engine);
    if ((this.repCounts.get(key) || 0) >= 3) {
      this.setResult({ type: 'repetition', winner: null, reason: 'pengulangan posisi 3×' }, true);
      return;
    }
    if (this.result && (this.result.type === 'checkmate' || this.result.type === 'stalemate' ||
        this.result.type === 'draw' || this.result.type === 'repetition' || this.result.type === 'insufficient')) {
      this.result = null;
    }
  }

  private setResult(r: Result, silent = false) {
    this.result = r;
    this.turnStartedAt = null;
    const t = this.now();
    void t;
    if (!silent) this.emit();
  }

  /* ---------------- aksi pemain ---------------- */
  sendChat(text: string) {
    const clean = String(text || '').slice(0, 300).trim();
    if (!clean) return;
    this.publish('chat', { text: clean });
    this.pushChat({ id: newId(), pid: this.pid, name: this.name, text: clean, at: this.now() });
  }

  private pushChat(entry: ChatEntry) {
    if (this.chatLog.some(c => c.id === entry.id)) return;
    this.chatLog.push(entry);
    if (this.chatLog.length > 200) this.chatLog.shift();
    this.emit();
  }

  offerDraw() { if (!this.result && this.sideOfPid(this.pid)) { this.publish('draw-offer', {}); } }
  acceptDraw() {
    if (this.result || !this.drawOffer || this.drawOffer === this.myRole) return;
    this.publish('draw-accept', {});
    this.setResult({ type: 'draw-agreed', winner: null, reason: 'damai disepakati' });
  }
  declineDraw() { if (this.drawOffer) { this.publish('draw-decline', {}); this.drawOffer = null; this.emit(); } }
  resign() {
    const role = this.myRole;
    if (this.result || (role !== 'w' && role !== 'b')) return;
    this.publish('resign', {});
    this.setResult({ type: 'resign', winner: oppSide(role), reason: (role === 'w' ? 'Putih' : 'Hitam') + ' menyerah' });
  }

  voteRematch() {
    if (!this.result || !this.sideOfPid(this.pid)) return;
    if (this.rematchVotes.has(this.pid)) return;
    this.publish('rematch-vote', { matchNo: this.matchNo });
    this.rematchVotes.add(this.pid);
    this.maybeStartRematch();
    this.emit();
  }

  private maybeStartRematch() {
    const both = seatOrder.every(s => {
      const pid = this.seatsPid[s];
      return pid && this.rematchVotes.has(pid);
    });
    if (!both) return;
    // kedua sisi menghitung hal yang sama → hasil identik
    this.matchNo += 1;
    this.seatsPid = { w: this.seatsPid.b, b: this.seatsPid.w };
    this.engine = E.parseFen(E.START_FEN);
    this.history = [];
    this.repCounts.clear();
    this.result = null;
    this.drawOffer = null;
    this.rematchVotes.clear();
    this.clockBase = { w: BASE_TIME, b: BASE_TIME };
    const t = this.now();
    this.startedAt = t;
    this.turnStartedAt = t;
    this.chatLog = [];
    this.lastError = null;
  }

  /* ---------------- detak: kehadiran, jam, batas waktu ---------------- */
  private clockView(t: number): ClockView {
    const c = { w: this.clockBase.w, b: this.clockBase.b };
    let running: Side | null = null;
    if (this.startedAt && !this.result && this.turnStartedAt !== null) {
      const turn = this.engine.turn;
      if (this.isSidePresent(turn, t)) {
        c[turn] = Math.max(0, c[turn] - (t - this.turnStartedAt));
        running = turn;
      }
    }
    return { ...c, running };
  }

  private tickAll() {
    const t = this.now();
    if (this.closed) return;

    // kehadiran
    if (this.net === 'online' && (!this.lastPresenceAt || t - this.lastPresenceAt >= PRESENCE_MS)) {
      this.lastPresenceAt = t;
      this.publish('presence', { name: this.name, want: this.me?.want || 'auto', ...this.digest() });
    }
    for (const rec of this.players.values()) if (rec.pid === this.pid) rec.lastSeen = t;
    this.resolveSeats();
    this.maybeStartGame();

    // transisi kehadiran pada giliran berjalan → materialisasi jam
    if (this.startedAt && !this.result) {
      const turn = this.engine.turn;
      const present = this.isSidePresent(turn, t);
      if (this.presentCache[turn] !== present) {
        if (!present) {
          this.clockBase[turn] = Math.max(0, this.clockView(t)[turn]);
          this.turnStartedAt = null;
        } else if (this.turnStartedAt === null) {
          this.turnStartedAt = t;
        }
        this.presentCache[turn] = present;
      }
    }

    // batas waktu
    if (this.startedAt && !this.result) {
      const view = this.clockView(t);
      for (const side of seatOrder) {
        if (view[side] > 0) continue;
        if (!this.isSidePresent(side, t)) continue;         // jam dijeda saat terputus
        if (this.myRole === side) this.declareTimeoutSide(side);
        else if (this.sideOfPid(this.pid)) this.declareTimeoutSide(side);
      }
    }
    this.emit();
  }
  private lastPresenceAt = 0;

  private declareTimeoutSide(loser: Side) {
    const t = this.now();
    if (t - (this.lastTimeoutAt || 0) < 2000) return;
    this.lastTimeoutAt = t;
    this.publish('timeout', { matchNo: this.matchNo, loser: this.seatsPid[loser] });
    this.clockBase[loser] = 0;
    this.setResult({ type: 'timeout', winner: oppSide(loser), reason: (loser === 'w' ? 'Putih' : 'Hitam') + ' kehabisan waktu' });
  }
  private lastTimeoutAt = 0;

  /* ---------------- tampilan ---------------- */
  private buildState(): PublicState {
    const t = this.now();
    const seatInfo = (side: Side): SeatInfo | null => {
      const pid = this.seatsPid[side];
      if (!pid) return null;
      const rec = this.players.get(pid);
      return {
        pid,
        name: rec?.name || 'Pemain',
        present: pid === this.pid ? true : !!rec && this.isPresentRec(rec, t),
      };
    };
    const w = seatInfo('w'), b = seatInfo('b');
    const status = this.result || (E.isInCheck(this.engine, this.engine.turn)
      ? { type: 'playing' as const, winner: null, reason: 'check' }
      : { type: 'playing' as const, winner: null, reason: null });
    const myRole = this.myRole;
    const oppSideOfMine: Side | null = myRole === 'w' ? 'b' : myRole === 'b' ? 'w' : null;
    const freeSeats = seatOrder.filter(s => {
      const holder = this.seatsPid[s];
      if (!holder) return true;
      const rec = this.players.get(holder);
      return !!rec && !this.isPresentRec(rec, t) && t - rec.lastSeen > ABSENT_MS * 2;
    });
    return {
      roomId: this.roomId,
      myPid: this.pid,
      myName: this.name,
      net: this.net,
      broker: this.netBroker,
      netDetail: this.netDetail,
      fen: E.toFen(this.engine),
      turn: this.engine.turn,
      inCheck: !this.result && E.isInCheck(this.engine, this.engine.turn),
      status: status as PublicState['status'],
      seats: { w, b },
      myRole,
      clock: this.clockView(t),
      history: this.history.slice(),
      chat: this.chatLog.slice(),
      drawOffer: this.drawOffer,
      rematch: {
        mine: this.rematchVotes.has(this.pid),
        theirs: !!oppSideOfMine && this.rematchVotes.has(this.seatsPid[oppSideOfMine] || ''),
      },
      spectators: [...this.players.values()].filter(p => !this.sideOfPid(p.pid) && this.isPresentRec(p, t)).length,
      opponentName: oppSideOfMine ? (this.seatsPid[oppSideOfMine] ? (this.players.get(this.seatsPid[oppSideOfMine]!)?.name || 'Pemain') : null) : null,
      matchNo: this.matchNo,
      started: !!this.startedAt,
      freeSeats,
      lastMove: this.history.length ? this.history[this.history.length - 1] : null,
      lastError: this.lastError,
    };
  }

  setError(msg: string | null) { this.lastError = msg; this.emit(); }
}
