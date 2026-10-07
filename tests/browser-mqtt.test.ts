/*
 * UJI PALING PENTING: dua browser sungguhan (laptop + HP) bermain catur lewat
 * broker MQTT publik — persis seperti yang terjadi setelah di-deploy ke Vercel.
 * Server Next.js hanya menyajikan halaman statis; tidak menyimpan state apa pun.
 *
 * Jalankan (butuh `next start` di :3100):
 *   BASE=http://127.0.0.1:3100 npx tsx tests/browser-mqtt.test.ts
 */
import { chromium, BrowserContext, Page } from 'playwright';
import * as path from 'path';

const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const SHOTS = path.join(__dirname, '..', 'screenshots');

let fails = 0;
const ok = (c: boolean, label: string, extra?: any) => {
  if (c) console.log('OK   ' + label);
  else { fails++; console.log('FAIL ' + label + (extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); }
};
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const sqSel = (i: number) => `#board [data-sq="${i}"]`;

async function waitText(page: Page, sel: string, re: RegExp, timeout = 20000): Promise<string | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const t = (await page.textContent(sel).catch(() => '')) || '';
    if (re.test(t)) return t;
    await sleep(70);
  }
  return null;
}
async function waitPiece(page: Page, i: number, timeout = 20000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await page.$(sqSel(i) + ' .piece')) return true;
    await sleep(70);
  }
  return false;
}
async function waitPly(page: Page, n: number, timeout = 25000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const t = (await page.textContent('[data-testid="ply-count"]').catch(() => '')) || '';
    if (parseInt(t, 10) === n) return true;
    await sleep(60);
  }
  return false;
}
async function waitMyTurn(page: Page, timeout = 25000): Promise<boolean> {
  return !!(await waitText(page, '[data-testid="status"]', /Giliranmu/, timeout));
}
async function click(page: Page, i: number) { await page.click(sqSel(i)); await sleep(70); }

/** Jalan + tunggu langkah itu benar-benar terlihat di KEDUA device (anti-balapan). */
async function playMove(page: Page, other: Page, from: number, to: number, expectPly: number) {
  await waitMyTurn(page);
  await click(page, from);
  await click(page, to);
  const a = await waitPly(page, expectPly);
  const b = await waitPly(other, expectPly);
  return a && b;
}

(async () => {
  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });

  // Device A — laptop
  const ctxA: BrowserContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const A = await ctxA.newPage();
  A.on('pageerror', e => { fails++; console.log('FAIL error JS di device A: ' + e.message); });
  A.on('dialog', d => d.accept());      // setujui dialog konfirmasi (mis. "yakin menyerah?")

  // Device B — HP
  const ctxB: BrowserContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const B = await ctxB.newPage();
  B.on('pageerror', e => { fails++; console.log('FAIL error JS di device B: ' + e.message); });
  B.on('dialog', d => d.accept());

  /* ---------- 1. Lobby & pembuatan room ---------- */
  await A.goto(BASE + '/', { waitUntil: 'load' });
  ok(await A.title() === 'Catur Online — Main Berdua dari 2 Device', 'lobby Next.js terbuka di laptop');
  await A.fill('[data-testid="in-name"]', 'Andi');
  await A.click('[data-testid="btn-create"]');
  await A.waitForURL(/\/r\/[a-z0-9]{6,}/, { timeout: 20000 });
  const code = A.url().match(/\/r\/([a-z0-9]+)/)![1];
  ok(/^[a-z0-9]{6,}$/.test(code), 'room baru dibuat dengan kode acak', code);
  await A.waitForSelector('#board .piece', { timeout: 20000 });
  ok((await A.$$('#board .piece')).length === 32, '32 bidak tergambar di papan laptop');
  ok(await A.isVisible('[data-testid="overlay-wait"]'), 'overlay menunggu lawan tampil');

  const warna = await A.evaluate(`(() => {
    const g = (i) => getComputedStyle(document.querySelector('#board [data-sq="' + i + '"]')).backgroundColor;
    const pieceText = (document.querySelector('#board [data-sq="52"] .piece') || {}).textContent || '';
    return { a1: g(56), h1: g(63), pieceText: pieceText };
  })()`) as { a1: string; h1: string; pieceText: string };
  ok(/176|127|82/.test(warna.a1) && /238|221|192/.test(warna.h1), 'warna petak standar: a1 gelap & h1 terang', warna);
  ok(warna.pieceText.length <= 2 && !/[\u{1F300}-\u{1FAFF}]/u.test(warna.pieceText), 'bidak memakai glyph teks (bukan emoji)', JSON.stringify(warna.pieceText));

  /* ---------- 2. Device B gabung lewat link undangan ---------- */
  await B.goto(BASE + '/r/' + code, { waitUntil: 'load' });
  await B.waitForSelector('#board .piece', { timeout: 25000 });
  ok(!!(await waitText(B, '[data-testid="seat-info"]', /Hitam/, 20000)), 'HP otomatis duduk sebagai Hitam',
    await B.textContent('[data-testid="seat-info"]'));
  ok(!!(await waitText(A, '[data-testid="seat-info"]', /Putih/, 15000)), 'laptop memegang kursi Putih');
  let overlayHilang = false;
  for (let i = 0; i < 200 && !overlayHilang; i++) { overlayHilang = (await A.$('[data-testid="overlay-wait"]')) === null; if (!overlayHilang) await sleep(100); }
  ok(overlayHilang, 'overlay menunggu hilang setelah lawan masuk (lewat broker publik)');

  /* ---------- 3. Langkah silang device lewat broker publik ---------- */
  ok(await playMove(A, B, 52, 36, 1), 'e4 dari laptop sampai & tercatat di kedua device (via MQTT publik)');
  ok(await waitPiece(B, 36), 'bidak e4 terlihat di papan HP');
  ok(!!(await waitText(B, '[data-testid="moves"]', /e4/, 15000)), 'riwayat di HP mencatat e4');
  ok(await playMove(B, A, 12, 28, 2), 'e5 balasan dari HP sampai ke laptop');
  ok(!!(await waitText(A, '[data-testid="moves"]', /e4\s*e5/, 15000)), 'kedua langkah tercatat di laptop');

  // klik di luar giliran tidak berpengaruh
  const plyBefore = await A.textContent('[data-testid="ply-count"]');
  await click(A, 11); await click(A, 27);
  await sleep(900);
  ok((await A.textContent('[data-testid="ply-count"]')) === plyBefore, 'klik saat bukan giliran tidak mengubah papan');

  ok(await playMove(A, B, 62, 45, 3), 'Nf3 dari laptop tersinkron ke HP');

  /* ---------- 4. Obrolan dua arah ---------- */
  await A.fill('[data-testid="chat-input"]', 'Semangat ya!');
  await A.press('[data-testid="chat-input"]', 'Enter');
  ok(!!(await waitText(B, '[data-testid="chat"]', /Semangat ya!/, 15000)), 'obrolan dari laptop sampai ke HP');
  await B.fill('[data-testid="chat-input"]', 'Ayo main!');
  await B.press('[data-testid="chat-input"]', 'Enter');
  ok(!!(await waitText(A, '[data-testid="chat"]', /Ayo main!/, 15000)), 'obrolan dari HP sampai ke laptop');

  /* ---------- 5. Muat ulang: kursi & posisi tetap ---------- */
  await A.reload({ waitUntil: 'load' });
  await A.waitForSelector('#board .piece', { timeout: 20000 });
  ok(!!(await waitText(A, '[data-testid="seat-info"]', /Putih/, 20000)), 'setelah reload, laptop tetap memegang kursi Putih');
  ok(!!(await waitText(A, '[data-testid="moves"]', /e4/, 15000)), 'riwayat langkah utuh setelah reload');
  ok(await waitPiece(A, 45, 10000), 'posisi bidak (kuda di f3) benar setelah reload');
  ok(await waitPly(A, 3, 15000), 'jumlah langkah kembali sinkron setelah reload');

  /* ---------- 6. Promosi lengkap lewat broker publik ---------- */
  // lanjutan: 2... d5  3. exd5  Nf6  4. d6  Nbd7  5. dxc7  h6  6. cxd8=Q+
  // (Hitam sudah main e5, jadi jalur promosi lewat sayap menteri: d6 → xc7 → xd8)
  ok(await playMove(B, A, 11, 27, 4), 'langkah d5 dari HP tercatat di kedua device');
  ok(await playMove(A, B, 36, 27, 5), 'exd5 dari laptop tercatat di kedua device');
  ok(await playMove(B, A, 6, 21, 6), 'Nf6 dari HP tercatat di kedua device');
  ok(await playMove(A, B, 27, 19, 7), 'd6 dari laptop tercatat di kedua device');
  ok(await playMove(B, A, 1, 11, 8), 'Nbd7 dari HP tercatat di kedua device');
  ok(await playMove(A, B, 19, 10, 9), 'dxc7 dari laptop tercatat di kedua device');
  ok(await playMove(B, A, 15, 23, 10), 'h6 dari HP tercatat di kedua device');

  await waitMyTurn(A);
  await click(A, 10);
  await click(A, 3);
  ok(await A.isVisible('[data-testid="promo"]'), 'dialog promosi muncul di device pemain');
  ok(!(await B.isVisible('[data-testid="promo"]')), 'dialog promosi tidak muncul di device lawan');
  await A.click('[data-testid="promo-q"]');
  ok(await waitPly(A, 11) && await waitPly(B, 11), 'langkah promosi tercatat di kedua device');
  ok(!!(await waitText(A, '[data-testid="moves"]', /cxd8=Q/, 15000)), 'notasi promosi cxd8=Q+ tercatat');
  ok(await waitPiece(B, 3), 'Ratu hasil promosi muncul di papan HP');
  ok(!!(await waitText(B, '[data-testid="status"]', /Skak/, 15000)), 'status HP memberitahu ada skak setelah promosi');
  const ratu = String(await A.evaluate(`(() => {
    const el = document.querySelector('#board [data-sq="3"] .piece');
    return el ? el.className + '|' + el.textContent : 'tidak ada';
  })()`));
  ok(/w/.test(ratu) && ratu.includes('\u265B'), 'bidak di d8 memang Ratu Putih', ratu);

  /* ---------- 7. Penonton dari device ketiga ---------- */
  const ctxC = await browser.newContext({ viewport: { width: 900, height: 800 } });
  const C = await ctxC.newPage();
  C.on('pageerror', e => { fails++; console.log('FAIL error JS di penonton: ' + e.message); });
  await C.goto(BASE + '/r/' + code, { waitUntil: 'load' });
  await C.waitForSelector('#board .piece', { timeout: 25000 });
  ok(!!(await waitText(C, '[data-testid="seat-info"]', /menonton/, 20000)), 'device ketiga menjadi penonton');
  ok(await waitPiece(C, 3, 20000), 'penonton langsung melihat posisi terkini (Ratu di d8)');
  ok(!!(await waitText(C, '[data-testid="moves"]', /cxd8=Q/, 15000)), 'penonton menerima riwayat lengkap');
  await ctxC.close();

  /* ---------- 8. Menyerah & rematch ---------- */
  await B.click('[data-testid="btn-resign"]');
  ok(!!(await waitText(A, '[data-testid="status"]', /menang/, 25000)), 'menyerah dari HP → laptop mengumumkan pemenang',
    await A.textContent('[data-testid="status"]'));
  ok(await A.isVisible('[data-testid="btn-rematch"]'), 'tombol Rematch muncul setelah permainan usai');
  await A.click('[data-testid="btn-rematch"]');
  await B.click('[data-testid="btn-rematch"]');
  ok(await waitPly(A, 0, 25000) && await waitPly(B, 0, 25000), 'papan & riwayat direset setelah rematch');
  ok(!!(await waitText(A, '[data-testid="seat-info"]', /Hitam/, 20000)), 'warna ditukar setelah rematch (laptop jadi Hitam)',
    await A.textContent('[data-testid="seat-info"]'));
  ok(!!(await waitText(B, '[data-testid="seat-info"]', /Putih/, 20000)), 'warna ditukar di HP juga');
  ok(await playMove(B, A, 52, 36, 1), 'pemain dengan warna Putih baru (HP) boleh jalan lebih dulu setelah rematch');

  /* ---------- 9. Bukti visual ---------- */
  const fs = require('fs');
  fs.mkdirSync(SHOTS, { recursive: true });
  await A.screenshot({ path: path.join(SHOTS, 'vercel-desktop.png') });
  await B.screenshot({ path: path.join(SHOTS, 'vercel-mobile.png') });
  console.log('\n📸 Screenshot: screenshots/vercel-desktop.png & screenshots/vercel-mobile.png');

  await browser.close();
  console.log(fails === 0 ? '\nSEMUA UJI BROWSER + MQTT LULUS ✅' : `\n${fails} UJI GAGAL ❌`);
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('ERROR:', e); process.exit(1); });
