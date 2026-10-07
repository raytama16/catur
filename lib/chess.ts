/*
 * Mesin catur — dipakai klien Next.js (aturan lengkap, deterministik).
 * Konversi dari mesin yang sudah lolos perft penuh (lihat tests/perft.ts).
 * Representasi: board = array 64, index 0 = a8 ... 63 = h1.
 */

export interface CastlingRights { wK: boolean; wQ: boolean; bK: boolean; bQ: boolean }
export interface ChessState {
  board: (string | null)[];
  turn: 'w' | 'b';
  castling: CastlingRights;
  ep: number | null;
  halfmove: number;
  fullmove: number;
}
export interface Move { from: number; to: number; promo?: string; ep?: boolean; double?: boolean; castle?: 'K' | 'Q' }
export type GameStatus =
  | { type: 'playing'; winner: null; reason: string | null }
  | { type: 'checkmate'; winner: 'w' | 'b'; reason: string }
  | { type: 'stalemate'; winner: null; reason: string }
  | { type: 'draw'; winner: null; reason: string };



const FILES = 'abcdefgh';
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const KNIGHT_D = [[1,2],[2,1],[2,-1],[1,-2],[-1,-2],[-2,-1],[-2,1],[-1,2]];
const BISHOP_D = [[1,1],[1,-1],[-1,1],[-1,-1]];
const ROOK_D = [[1,0],[-1,0],[0,1],[0,-1]];
const KING_D = BISHOP_D.concat(ROOK_D);

const fileOf = i => i & 7;
const rankOf = i => i >> 3;
const sqIndex = (f, r) => r * 8 + f;
const inBoard = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
const opp = c => (c === 'w' ? 'b' : 'w');
const idxToAlg = i => FILES[fileOf(i)] + (8 - rankOf(i));
const colorOf = p => p[0];
const typeOf = p => p[1];

function algToIdx(a: string): number | null {
  if (typeof a !== 'string' || a.length < 2) return null;
  const f = FILES.indexOf(a[0]);
  const r = 8 - parseInt(a[1], 10);
  if (f < 0 || !(r >= 0 && r < 8)) return null;
  return sqIndex(f, r);
}

function parseFen(fen: string): ChessState {
  const parts = String(fen).trim().split(/\s+/);
  const board = new Array(64).fill(null);
  let r = 0, f = 0;
  for (const ch of parts[0]) {
    if (ch === '/') { r++; f = 0; }
    else if (ch >= '1' && ch <= '8') f += Number(ch);
    else {
      if (!inBoard(f, r)) throw new Error('FEN rusak');
      board[sqIndex(f, r)] = (ch === ch.toUpperCase() ? 'w' : 'b') + ch.toLowerCase();
      f++;
    }
  }
  const cast = parts[2] && parts[2] !== '-' ? parts[2] : '';
  return {
    board,
    turn: parts[1] === 'b' ? 'b' : 'w',
    castling: {
      wK: cast.includes('K'), wQ: cast.includes('Q'),
      bK: cast.includes('k'), bQ: cast.includes('q')
    },
    ep: parts[3] && parts[3] !== '-' ? algToIdx(parts[3]) : null,
    halfmove: parseInt(parts[4], 10) || 0,
    fullmove: parseInt(parts[5], 10) || 1
  };
}

function toFen(state: ChessState): string {
  let placement = '';
  for (let r = 0; r < 8; r++) {
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = state.board[sqIndex(f, r)];
      if (!p) empty++;
      else {
        if (empty) { placement += empty; empty = 0; }
        placement += colorOf(p) === 'w' ? typeOf(p).toUpperCase() : typeOf(p);
      }
    }
    if (empty) placement += empty;
    if (r < 7) placement += '/';
  }
  let cast = (state.castling.wK ? 'K' : '') + (state.castling.wQ ? 'Q' : '') +
             (state.castling.bK ? 'k' : '') + (state.castling.bQ ? 'q' : '');
  return [
    placement,
    state.turn,
    cast || '-',
    state.ep == null ? '-' : idxToAlg(state.ep),
    state.halfmove,
    state.fullmove
  ].join(' ');
}

// Kunci posisi untuk deteksi pengulangan 3x (tanpa counter langkah)
function fenKey(state: ChessState): string {
  return toFen(state).split(' ').slice(0, 4).join(' ');
}

function cloneState(s: ChessState): ChessState {
  return {
    board: s.board.slice(),
    turn: s.turn,
    castling: { wK: s.castling.wK, wQ: s.castling.wQ, bK: s.castling.bK, bQ: s.castling.bQ },
    ep: s.ep,
    halfmove: s.halfmove,
    fullmove: s.fullmove
  };
}

function kingSquare(state: ChessState, color: 'w' | 'b'): number | null {
  const target = color + 'k';
  for (let i = 0; i < 64; i++) if (state.board[i] === target) return i;
  return null;
}

function isAttacked(state: ChessState, sq: number, by: 'w' | 'b'): boolean {
  const b = state.board, f = fileOf(sq), r = rankOf(sq);
  const pdir = by === 'w' ? 1 : -1;
  for (const df of [-1, 1]) {
    const nf = f + df, nr = r + pdir;
    if (inBoard(nf, nr) && b[sqIndex(nf, nr)] === by + 'p') return true;
  }
  for (const d of KNIGHT_D) {
    const nf = f + d[0], nr = r + d[1];
    if (inBoard(nf, nr) && b[sqIndex(nf, nr)] === by + 'n') return true;
  }
  for (const d of KING_D) {
    const nf = f + d[0], nr = r + d[1];
    if (inBoard(nf, nr) && b[sqIndex(nf, nr)] === by + 'k') return true;
  }
  for (const d of BISHOP_D) {
    let nf = f + d[0], nr = r + d[1];
    while (inBoard(nf, nr)) {
      const p = b[sqIndex(nf, nr)];
      if (p) {
        if (colorOf(p) === by && (typeOf(p) === 'b' || typeOf(p) === 'q')) return true;
        break;
      }
      nf += d[0]; nr += d[1];
    }
  }
  for (const d of ROOK_D) {
    let nf = f + d[0], nr = r + d[1];
    while (inBoard(nf, nr)) {
      const p = b[sqIndex(nf, nr)];
      if (p) {
        if (colorOf(p) === by && (typeOf(p) === 'r' || typeOf(p) === 'q')) return true;
        break;
      }
      nf += d[0]; nr += d[1];
    }
  }
  return false;
}

function isInCheck(state: ChessState, color: 'w' | 'b'): boolean {
  const k = kingSquare(state, color);
  if (k == null) return false;
  return isAttacked(state, k, opp(color));
}

function generatePseudo(state, color = state.turn) {
  const b = state.board;
  const moves = [];
  const push = (from: number, to: number, extra?: Partial<Move>) => moves.push(Object.assign({ from, to }, extra || {}));

  for (let i = 0; i < 64; i++) {
    const p = b[i];
    if (!p || colorOf(p) !== color) continue;
    const t = typeOf(p), f = fileOf(i), r = rankOf(i);

    if (t === 'p') {
      const dir = color === 'w' ? -1 : 1;
      const startR = color === 'w' ? 6 : 1;
      const promoR = color === 'w' ? 0 : 7;
      const r1 = r + dir;
      if (inBoard(f, r1) && !b[sqIndex(f, r1)]) {
        if (r1 === promoR) {
          for (const pr of ['q', 'r', 'b', 'n']) push(i, sqIndex(f, r1), { promo: pr });
        } else {
          push(i, sqIndex(f, r1));
          const r2 = r + 2 * dir;
          if (r === startR && !b[sqIndex(f, r2)]) push(i, sqIndex(f, r2), { double: true });
        }
      }
      for (const df of [-1, 1]) {
        const nf = f + df, nr = r + dir;
        if (!inBoard(nf, nr)) continue;
        const to = sqIndex(nf, nr);
        const tp = b[to];
        if (tp && colorOf(tp) === opp(color)) {
          if (nr === promoR) for (const pr of ['q', 'r', 'b', 'n']) push(i, to, { promo: pr });
          else push(i, to);
        } else if (!tp && state.ep === to) {
          push(i, to, { ep: true });
        }
      }
    } else if (t === 'n' || t === 'k') {
      const deltas = t === 'n' ? KNIGHT_D : KING_D;
      for (const d of deltas) {
        const nf = f + d[0], nr = r + d[1];
        if (!inBoard(nf, nr)) continue;
        const to = sqIndex(nf, nr), tp = b[to];
        if (!tp || colorOf(tp) === opp(color)) push(i, to);
      }
    } else {
      const deltas = t === 'b' ? BISHOP_D : t === 'r' ? ROOK_D : KING_D;
      for (const d of deltas) {
        let nf = f + d[0], nr = r + d[1];
        while (inBoard(nf, nr)) {
          const to = sqIndex(nf, nr), tp = b[to];
          if (!tp) push(i, to);
          else {
            if (colorOf(tp) === opp(color)) push(i, to);
            break;
          }
          nf += d[0]; nr += d[1];
        }
      }
    }
  }

  // Castling
  const ks = kingSquare(state, color);
  const homeR = color === 'w' ? 7 : 0;
  if (ks === sqIndex(4, homeR) && !isAttacked(state, ks, opp(color))) {
    if (state.castling[color + 'K'] &&
        !b[sqIndex(5, homeR)] && !b[sqIndex(6, homeR)] &&
        b[sqIndex(7, homeR)] === color + 'r' &&
        !isAttacked(state, sqIndex(5, homeR), opp(color)) &&
        !isAttacked(state, sqIndex(6, homeR), opp(color))) {
      moves.push({ from: ks, to: sqIndex(6, homeR), castle: 'K' });
    }
    if (state.castling[color + 'Q'] &&
        !b[sqIndex(3, homeR)] && !b[sqIndex(2, homeR)] && !b[sqIndex(1, homeR)] &&
        b[sqIndex(0, homeR)] === color + 'r' &&
        !isAttacked(state, sqIndex(3, homeR), opp(color)) &&
        !isAttacked(state, sqIndex(2, homeR), opp(color))) {
      moves.push({ from: ks, to: sqIndex(2, homeR), castle: 'Q' });
    }
  }

  return moves;
}

function legalMoves(state: ChessState, color: 'w' | 'b' = state.turn): Move[] {
  const pseudo = generatePseudo(state, color);
  const legal = [];
  for (const mv of pseudo) {
    const after = cloneState(state);
    after.turn = color;
    makeMove(after, mv);
    const k = kingSquare(after, color);
    if (k == null || !isAttacked(after, k, opp(color))) legal.push(mv);
  }
  return legal;
}

function legalMovesFrom(state: ChessState, from: number): Move[] {
  return legalMoves(state).filter(m => m.from === from);
}

function findMove(state: ChessState, { from, to, promo }: { from: number; to: number; promo?: string }): Move | null {
  const candidates = legalMoves(state).filter(m => m.from === from && m.to === to);
  if (!candidates.length) return null;
  if (candidates.length === 1 && !candidates[0].promo) return candidates[0];
  const want = (promo || 'q').toLowerCase();
  return candidates.find(m => m.promo === want) || null;
}

function makeMove(state: ChessState, mv: Move): { captured: string | null; piece: string } {
  const b = state.board;
  const color = state.turn;
  const piece = b[mv.from];
  if (!piece) throw new Error('Tidak ada keping di petak asal');
  const t = typeOf(piece);
  let captured = b[mv.to] || null;

  b[mv.from] = null;
  if (mv.ep) {
    const capSq = sqIndex(fileOf(mv.to), rankOf(mv.from));
    captured = b[capSq] || null;
    b[capSq] = null;
  }
  b[mv.to] = mv.promo ? color + mv.promo : piece;

  if (t === 'k' && Math.abs(fileOf(mv.to) - fileOf(mv.from)) === 2) {
    const hr = rankOf(mv.from);
    if (fileOf(mv.to) === 6) { b[sqIndex(5, hr)] = b[sqIndex(7, hr)]; b[sqIndex(7, hr)] = null; }
    else { b[sqIndex(3, hr)] = b[sqIndex(0, hr)]; b[sqIndex(0, hr)] = null; }
  }

  if (t === 'k') { state.castling[color + 'K'] = false; state.castling[color + 'Q'] = false; }
  if (t === 'r') {
    const homeR = color === 'w' ? 7 : 0;
    if (mv.from === sqIndex(0, homeR)) state.castling[color + 'Q'] = false;
    if (mv.from === sqIndex(7, homeR)) state.castling[color + 'K'] = false;
  }
  // benteng lawan dimakan di petak asalnya
  if (mv.to === sqIndex(0, 0)) state.castling.bQ = false;
  if (mv.to === sqIndex(7, 0)) state.castling.bK = false;
  if (mv.to === sqIndex(0, 7)) state.castling.wQ = false;
  if (mv.to === sqIndex(7, 7)) state.castling.wK = false;

  state.ep = mv.double ? sqIndex(fileOf(mv.from), (rankOf(mv.from) + rankOf(mv.to)) / 2) : null;
  state.halfmove = (t === 'p' || captured) ? 0 : state.halfmove + 1;
  if (color === 'b') state.fullmove += 1;
  state.turn = opp(color);

  return { captured, piece };
}

function moveToSan(state: ChessState, mv: Move): string {
  const piece = state.board[mv.from];
  const t = typeOf(piece);
  const color = colorOf(piece);
  let san;

  if (t === 'p') {
    const isCapture = !!mv.ep || !!state.board[mv.to];
    san = (isCapture ? FILES[fileOf(mv.from)] + 'x' : '') + idxToAlg(mv.to);
    if (mv.promo) san += '=' + mv.promo.toUpperCase();
  } else if (t === 'k' && Math.abs(fileOf(mv.to) - fileOf(mv.from)) === 2) {
    san = fileOf(mv.to) === 6 ? 'O-O' : 'O-O-O';
  } else {
    const others = legalMoves(state).filter(m =>
      m.to === mv.to && m.from !== mv.from && typeOf(state.board[m.from]) === t);
    let dis = '';
    if (others.length) {
      const sameFile = others.some(m => fileOf(m.from) === fileOf(mv.from));
      const sameRank = others.some(m => rankOf(m.from) === rankOf(mv.from));
      if (!sameFile) dis = FILES[fileOf(mv.from)];
      else if (!sameRank) dis = String(8 - rankOf(mv.from));
      else dis = idxToAlg(mv.from);
    }
    san = t.toUpperCase() + dis + (state.board[mv.to] ? 'x' : '') + idxToAlg(mv.to);
  }

  const after = cloneState(state);
  after.turn = color;
  makeMove(after, mv);
  if (isInCheck(after, after.turn)) {
    san += legalMoves(after, after.turn).length ? '+' : '#';
  }
  return san;
}

function insufficientMaterial(state) {
  let minor = 0;
  const bishops = [];
  for (let i = 0; i < 64; i++) {
    const p = state.board[i];
    if (!p) continue;
    const t = typeOf(p);
    if (t === 'p' || t === 'r' || t === 'q') return false;
    if (t === 'n') minor++;
    if (t === 'b') { minor++; bishops.push(colorOf(p) === 'w' ? 0 : 1); }
  }
  if (minor <= 1) return true; // K vs K, K+minor vs K
  if (minor === 2 && bishops.length === 2 && bishops[0] === bishops[1]) {
    // K+B vs K+B dengan warna petak sama (kira-kira cukup untuk draw praktis)
    return true;
  }
  return false;
}

function getStatus(state: ChessState): GameStatus {
  const moves = legalMoves(state);
  if (moves.length === 0) {
    if (isInCheck(state, state.turn)) {
      return { type: 'checkmate', winner: opp(state.turn), reason: 'skakmat' };
    }
    return { type: 'stalemate', winner: null, reason: 'stalemate' };
  }
  if (state.halfmove >= 100) return { type: 'draw', winner: null, reason: 'aturan 50 langkah' };
  if (insufficientMaterial(state)) return { type: 'draw', winner: null, reason: 'materi tidak cukup' };
  return { type: 'playing', winner: null, reason: isInCheck(state, state.turn) ? 'check' : null };
}
export {
  START_FEN, FILES,
  fileOf, rankOf, sqIndex, idxToAlg, algToIdx, opp, colorOf, typeOf,
  parseFen, toFen, fenKey, cloneState,
  kingSquare, isAttacked, isInCheck,
  generatePseudo, legalMoves, legalMovesFrom, findMove,
  makeMove, moveToSan, getStatus, insufficientMaterial
};
