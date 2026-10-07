/*
 * Membuat tangkapan layar dokumentasi (laptop + HP) lewat broker publik.
 * Jalankan: BASE=http://127.0.0.1:3100 npx tsx tests/screenshots.ts
 */
import { chromium } from 'playwright';
import * as path from 'path';
const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const SHOTS = path.join(__dirname, '..', 'screenshots');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

(async () => {
  const br = await chromium.launch({ args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const ctxA = await br.newContext({ viewport: { width: 1280, height: 900 } });
  const ctxB = await br.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const A = await ctxA.newPage(), B = await ctxB.newPage();

  await A.goto(BASE + '/');
  await A.fill('[data-testid="in-name"]', 'Andi');
  await A.click('[data-testid="btn-create"]');
  await A.waitForURL(/\/r\//);
  const code = A.url().match(/\/r\/([a-z0-9]+)/)![1];
  await A.waitForSelector('#board .piece');
  await B.goto(BASE + '/r/' + code);
  await B.waitForSelector('#board .piece');
  await sleep(2500);

  const play = async (p: any, f: number, t: number) => {
    await p.click(`#board [data-sq="${f}"]`); await sleep(80);
    await p.click(`#board [data-sq="${t}"]`); await sleep(1200);
  };
  // garis pembukaan yang enak dilihat: 1.e4 e5 2.Nf3 Nc6 3.Bc4 Bc5
  await play(A, 52, 36); await play(B, 12, 28); await play(A, 62, 45);
  await play(B, 1, 18);  await play(A, 61, 34); await play(B, 5, 26);
  await A.fill('[data-testid="chat-input"]', 'Halo, mulai ya!');
  await A.press('[data-testid="chat-input"]', 'Enter');
  await sleep(1500);

  await A.screenshot({ path: path.join(SHOTS, 'vercel-desktop.png') });
  await B.evaluate(`window.scrollTo(0, 0)`);
  await sleep(300);
  await B.screenshot({ path: path.join(SHOTS, 'vercel-mobile.png') });
  console.log('Screenshot dibuat:', SHOTS + '/vercel-desktop.png , vercel-mobile.png');
  console.log('Kode room contoh:', code);
  await br.close();
  process.exit(0);
})();
