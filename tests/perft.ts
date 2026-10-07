/*
 * Uji mesin: perft (pembanding standar industri) + skenario nyata.
 * Jalankan: npx tsx tests/perft.ts
 */
import * as E from '../lib/chess';

function perft(fen: string, depth: number): number {
  const st = E.parseFen(fen);
  function go(s: E.ChessState, d: number): number {
    if (d === 0) return 1;
    const moves = E.legalMoves(s);
    if (d === 1) return moves.length;
    let n = 0;
    for (const mv of moves) { const c = E.cloneState(s); E.makeMove(c, mv); n += go(c, d - 1); }
    return n;
  }
  return go(st, depth);
}

const tests = [
  { name: 'Startpos', fen: E.START_FEN, expected: [20, 400, 8902, 197281] },
  { name: 'Kiwipete', fen: 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1', expected: [48, 2039, 97862] },
  { name: 'Posisi 3', fen: '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1', expected: [14, 191, 2812, 43238] },
  { name: 'Promosi', fen: 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1', expected: [6, 264, 9467] },
];

let fail = 0;
for (const t of tests) {
  for (let d = 1; d <= t.expected.length; d++) {
    const got = perft(t.fen, d);
    const want = t.expected[d - 1];
    const ok = got === want;
    if (!ok) fail++;
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${t.name} depth ${d}: ${got} (harus ${want})`);
  }
}

function play(fen: string, sans: string[]) {
  const st = E.parseFen(fen);
  const out: string[] = [];
  for (const s of sans) {
    let mv: E.Move | null = null;
    for (const m of E.legalMoves(st)) if (E.moveToSan(st, m) === s) { mv = m; break; }
    if (!mv) throw new Error('SAN tidak ditemukan: ' + s + ' pada ' + E.toFen(st));
    out.push(E.moveToSan(st, mv));
    E.makeMove(st, mv);
  }
  return { st, out };
}

console.log('\n--- Skenario ---');
{
  const { st } = play(E.START_FEN, ['f3', 'e5', 'g4', 'Qh4#']);
  const s = E.getStatus(st);
  const ok = s.type === 'checkmate' && s.winner === 'b';
  if (!ok) fail++;
  console.log((ok ? 'OK  ' : 'FAIL') + " Fool's mate → " + JSON.stringify(s));
}
{
  const { out } = play(E.START_FEN, ['e4', 'e5', 'Nf3', 'Nc6', 'Bc4', 'Bc5', 'O-O', 'Nf6', 'd3', 'd6', 'a3', 'O-O']);
  const ok = out[6] === 'O-O' && out[11] === 'O-O';
  if (!ok) fail++;
  console.log((ok ? 'OK  ' : 'FAIL') + ' Castling kedua sisi → ' + out.join(' '));
}
{
  const { st } = play(E.START_FEN, ['e4', 'a6', 'e5', 'd5', 'exd6']);
  const ok = st.board[E.algToIdx('d6')!] === 'wp';
  if (!ok) fail++;
  console.log((ok ? 'OK  ' : 'FAIL') + ' En passant → ' + E.toFen(st));
}
{
  const { st } = play('8/P7/8/8/8/8/6k1/4K3 w - - 0 1', ['a8=Q+']);
  const ok = st.board[E.algToIdx('a8')!] === 'wq';
  if (!ok) fail++;
  console.log((ok ? 'OK  ' : 'FAIL') + ' Promosi → ' + E.toFen(st));
}
{
  const st = E.parseFen('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  const s = E.getStatus(st);
  const ok = s.type === 'stalemate';
  if (!ok) fail++;
  console.log((ok ? 'OK  ' : 'FAIL') + ' Stalemate → ' + JSON.stringify(s));
}
{
  const st = E.parseFen('r3k2r/8/8/8/8/8/6q1/R3K2R w KQkq - 0 1');
  const castle = E.legalMoves(st).filter(m => m.castle);
  const ok = castle.length === 1;
  if (!ok) fail++;
  console.log((ok ? 'OK  ' : 'FAIL') + ' Castling dicegah saat petak diserang → ' + castle.length + ' opsi');
}
console.log(fail === 0 ? '\nSEMUA UJI MESIN LULUS ✅' : `\n${fail} UJI MESIN GAGAL ❌`);
process.exit(fail === 0 ? 0 : 1);
