/*
 * Uji logika Room dengan transport dalam memori — tiga "device" virtual.
 * Jalankan: npx tsx tests/room.test.ts
 *
 * Yang diuji: kursi, langkah silang device, penolakan langkah ilegal,
 * obrolan, sinkronisasi ulang saat ada pesan yang hilang, penonton,
 * jam + batas waktu (memakai jam virtual), rematch, dan skenario reload.
 */
import { MemoryTransport } from '../lib/transport';
import { Room } from '../lib/room';
import { BASE_TIME, Envelope } from '../lib/protocol';
import * as E from '../lib/chess';

let fails = 0;
const ok = (c: boolean, label: string, extra?: any) => {
  if (c) console.log('OK   ' + label);
  else { fails++; console.log('FAIL ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const fenOf = (r: Room) => r.getState().fen;
const histOf = (r: Room) => r.getState().history.map(h => h.san).join(' ');
const sq = (alg: string) => E.algToIdx(alg)!;

async function waitFor(fn: () => boolean, timeout = 4000, label = 'kondisi') {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) { if (fn()) return true; await sleep(25); }
  console.log('   (timeout menunggu ' + label + ')');
  return false;
}

/** Jam virtual supaya uji batas waktu deterministik. */
function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

(async () => {
  /* ============ 1. Dua device: kursi & langkah silang ============ */
  const busA = new MemoryTransport('room-uji');
  const busB = new MemoryTransport('room-uji');
  busA.link(busB);

  const A = new Room({ roomId: 'room-uji', pid: 'pid-A', name: 'Andi', transport: busA, preferSide: 'w' });
  const B = new Room({ roomId: 'room-uji', pid: 'pid-B', name: 'Siti', transport: busB });
  A.connect(); B.connect();
  await waitFor(() => A.getState().seats.b !== null, 3000, 'kursi hitam terisi');

  ok(A.getState().myRole === 'w', 'device A duduk sebagai Putih', A.getState().myRole);
  ok(B.getState().myRole === 'b', 'device B duduk sebagai Hitam', B.getState().myRole);
  ok(A.getState().started && B.getState().started, 'permainan dianggap mulai di kedua device');
  ok(A.getState().seats.w?.name === 'Andi' && B.getState().seats.b?.name === 'Siti', 'nama pemain tampil di kursi');

  // e4 dari A
  const mv1 = A.move(sq('e2'), sq('e4'));
  ok(mv1.ok, 'A berhasil jalan e2-e4');
  ok(await waitFor(() => histOf(B).includes('e4'), 3000, 'e4 sampai ke B'), 'langkah A terlihat di device B');
  ok(fenOf(A) === fenOf(B), 'posisi papan identik di kedua device', { a: fenOf(A), b: fenOf(B) });
  ok(B.getState().turn === 'b', 'giliran berpindah ke Hitam di device B');

  // langkah ilegal & di luar giliran
  const bad = B.move(sq('e4'), sq('e5'));
  ok(!bad.ok, 'B tidak bisa jalan saat giliran Putih', bad);

  // e5 dari B
  const mv2 = B.move(sq('e7'), sq('e5'));
  ok(mv2.ok, 'B berhasil jalan e7-e5');
  ok(await waitFor(() => histOf(A).includes('e5'), 3000, 'e5 sampai ke A'), 'langkah B terlihat di device A');
  ok(fenOf(A) === fenOf(B), 'papan masih identik setelah dua langkah');
  ok(histOf(A) === 'e4 e5', 'notasi SAN tercatat berurutan', histOf(A));

  // giliran kembali ke Putih
  ok(A.getState().turn === 'w' && A.canMoveNow(), 'giliran kembali ke Putih (A boleh jalan)');

  /* ============ 2. Obrolan & tawaran damai ============ */
  B.sendChat('Halo Andi!');
  ok(await waitFor(() => A.getState().chat.some(c => c.text === 'Halo Andi!'), 3000, 'chat'), 'chat dari B sampai ke A');
  A.offerDraw();
  ok(await waitFor(() => B.getState().drawOffer === 'w', 3000, 'tawaran damai'), 'tawaran damai dari A sampai ke B');
  B.declineDraw();
  ok(await waitFor(() => A.getState().drawOffer === null, 3000, 'penolakan'), 'penolakan damai tersinkron');

  /* ============ 3. Penyembuhan diri saat pesan hilang ============ */
  // B "kehilangan" satu langkah A karena jaringannya putus sebentar
  busB.receiveBlock = true as any;
  const mv3 = A.move(sq('d2'), sq('d4'));      // d4 — pesannya tidak sampai ke B
  ok(mv3.ok, 'A jalan d4 (pesannya sengaja tidak sampai ke B)');
  await sleep(200);
  ok(histOf(B) === 'e4 e5', 'device B memang tertinggal (riwayat 2 langkah)', histOf(B));

  // setelah jaringan pulih, detak kehadiran mendeteksi selisih & menyinkronkan
  busB.receiveBlock = false as any;
  const healed = await waitFor(() => histOf(B) === 'e4 e5 d4', 12000, 'sinkronisasi ulang');
  ok(healed, 'B menyembuhkan diri sendiri lewat protokol snapshot');
  ok(fenOf(A) === fenOf(B), 'papan kembali identik setelah penyembuhan', { a: fenOf(A), b: fenOf(B) });

  /* ============ 4. Penonton ikut menyaksikan dari kondisi terkini ============ */
  const busC = new MemoryTransport('room-uji');
  busC.link(busA); busC.link(busB);
  const C = new Room({ roomId: 'room-uji', pid: 'pid-C', name: 'Penonton', transport: busC });
  C.connect();
  ok(await waitFor(() => C.getState().history.length === 3, 6000, 'snapshot untuk penonton'), 'penonton langsung dapat riwayat lengkap');
  ok(C.getState().myRole === 'spectator', 'device C berperan sebagai penonton', C.getState().myRole);
  ok(fenOf(C) === fenOf(A), 'papan penonton identik dengan pemain');
  ok(!C.move(sq('d7'), sq('d5')).ok, 'penonton tidak bisa jalan');
  ok(C.getState().spectators >= 1, 'jumlah penonton terhitung', C.getState().spectators);

  /* ============ 5. Reload: device B menyambung ulang dengan pid sama ============ */
  B.close();
  busB.close();
  const busB2 = new MemoryTransport('room-uji');
  busB2.link(busA); busB2.link(busC);
  const B2 = new Room({ roomId: 'room-uji', pid: 'pid-B', name: 'Siti', transport: busB2 });
  B2.connect();
  ok(await waitFor(() => B2.getState().history.length === 3, 6000, 'B2 dapat snapshot'), 'setelah reload, device B menerima keadaan terkini');
  ok(B2.getState().myRole === 'b', 'kursi Hitam tetap milik pid-B setelah reload', B2.getState().myRole);
  ok(fenOf(B2) === fenOf(A), 'papan device yang dimuat ulang identik');

  // lanjut main: giliran Hitam (B2)
  ok(await waitFor(() => B2.canMoveNow(), 3000, 'giliran B2'), 'giliran bermain berlanjut setelah reload');
  const mv4 = B2.move(sq('b8'), sq('c6'));
  ok(mv4.ok, 'B2 lanjut jalan Nc6');
  ok(await waitFor(() => histOf(A).includes('Nc6'), 3000, 'Nc6 ke A'), 'langkah lanjutan sampai ke device A');

  /* ============ 6. Jam & batas waktu (jam virtual) ============ */
  {
    const clk = makeClock();
    const t1 = new MemoryTransport('room-jam');
    const t2 = new MemoryTransport('room-jam');
    t1.link(t2);
    const P1 = new Room({ roomId: 'room-jam', pid: 'p1', name: 'Putih', transport: t1, preferSide: 'w', now: clk.now });
    const P2 = new Room({ roomId: 'room-jam', pid: 'p2', name: 'Hitam', transport: t2, now: clk.now });
    P1.connect(); P2.connect();
    await waitFor(() => P1.getState().started && P2.getState().started, 3000, 'permainan mulai');
    const before = P2.getState().clock.w;
    // majukan 1 detik per langkah sambil memberi kesempatan detak kehadiran lewat
    for (let i = 0; i < 60; i++) { clk.advance(1000); P1['tickAll'](); P2['tickAll'](); await sleep(1); }
    await sleep(30);
    const after = P2.getState().clock.w;
    ok(before - after > 55_000 && before - after < 65_000, 'jam Putih berjalan mundur sesuai waktu', { before, after });
    ok(P2.getState().clock.running === 'w', 'yang dihitung hanya pemain yang giliran');

    // habiskan sisa waktu Putih (total 10 menit terpakai)
    const kekurangan = Math.max(0, P2.getState().clock.w) + 5000;
    for (let i = 0; i < Math.ceil(kekurangan / 1000); i++) {
      clk.advance(1000); P1['tickAll'](); P2['tickAll']();
      if (i % 10 === 0) await sleep(1);
    }
    await sleep(120);
    ok(await waitFor(() => !!P2.getState().status && P2.getState().status.type === 'timeout', 3000, 'timeout terdeteksi'),
      'kehabisan waktu → permainan selesai otomatis', P2.getState().status);
    ok(P2.getState().status.winner === 'b', 'kemenangan diberikan ke Hitam');
    P1.close(); P2.close();
  }

  /* ============ 7. Rematch: warna ditukar & papan direset ============ */
  A.resign();
  ok(await waitFor(() => B2.getState().status.type === 'resign', 3000, 'resign tersinkron'), 'menyerah menyelesaikan permainan di kedua device');
  ok(A.getState().status.winner === 'b' && B2.getState().status.winner === 'b', 'pemenang konsisten', { a: A.getState().status, b: B2.getState().status });
  A.voteRematch();
  ok(await waitFor(() => B2.getState().rematch.theirs, 3000, 'vote rematch'), 'lawan diberi tahu ada permintaan rematch');
  B2.voteRematch();
  ok(await waitFor(() => A.getState().matchNo === 2 && B2.getState().matchNo === 2, 4000, 'rematch mulai'),
    'kedua device memulai pertandingan baru (matchNo naik)');
  ok(A.getState().myRole === 'b' && B2.getState().myRole === 'w', 'warna ditukar setelah rematch', { a: A.getState().myRole, b: B2.getState().myRole });
  ok(A.getState().history.length === 0 && B2.getState().history.length === 0, 'papan & riwayat direset');
  ok(Math.round(A.getState().clock.w / 1000) === BASE_TIME / 1000, 'jam dikembalikan ke 10 menit', A.getState().clock);

  // yang sekarang memegang Putih (B2) jalan lebih dulu
  ok(B2.canMoveNow(), 'pemain dengan warna Putih baru jalan lebih dulu');
  B2.move(sq('d2'), sq('d4'));
  ok(await waitFor(() => histOf(A) === 'd4', 3000, 'd4 ke A'), 'langkah pertama setelah rematch tersinkron');

  A.close(); B2.close(); C.close();
  busA.close(); busB2.close(); busC.close();

  console.log(fails === 0 ? '\nSEMUA UJI ROOM LULUS ✅' : `\n${fails} UJI ROOM GAGAL ❌`);
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
