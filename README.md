# ♞ Catur Online untuk Vercel — 2 Device, Tanpa Database

Catur online 2 pemain dari **dua device berbeda** (HP vs laptop, beda kota), dibangun
dengan **Next.js** dan siap di-hosting di **Vercel**. **Tidak ada database, tidak ada akun,
tidak ada API server** — halaman ini murni statis/SSR biasa.

> Versi ini adalah port dari versi Node.js (`../catur-online`) yang menyimpan room di
> memori server. Karena Vercel *serverless* tidak bisa menyimpan state antar-request dan
> tidak mendukung WebSocket, arsitektur diubah: **otoritas permainan ada di klien, dan
> kedua device bertukar pesan lewat broker MQTT publik**. Hasilnya tetap sama bagi pemain.

---

## Kenapa bisa tanpa database?

| Kebutuhan | Cara dipenuhi |
|---|---|
| "Ruangan" untuk 2 pemain | **Topik MQTT** `catur/v1/<kode-room>` (broker publik gratis, tanpa akun) |
| Papan, giliran, riwayat | Dihitung **di browser** dengan mesin catur yang sama di kedua device (deterministik) |
| Siapa Putih, siapa Hitam | **Kursi menempel pada `pid`** yang disimpan di `localStorage` browser |
| Pemain kabur / jaringan putus | **Snapshot + putar ulang riwayat**; setiap 8 detik ada "detak" berisi ringkasan, jadi device yang tertinggal menyembuhkan diri sendiri |
| Jam catur | Dihitung lokal dari waktu langkah terakhir; **dijeda otomatis** saat pemain giliran terputus |
| Vercel tidak menyimpan apa pun | Routing, build, dan file statis saja — tidak ada API route, tidak ada koneksi database |

Server Vercel **tidak pernah menyentuh data permainan**. Kalau dua pemain sama-sama menutup
browser, pertandingan itu memang hilang (bukan disimpan di mana pun).

---

## Menjalankan di komputer

```bash
npm install
npm run dev          # http://localhost:3000
```

Uji coba satu browser saja? Tambahkan `?solo=1`:
`http://localhost:3000/r/<kode>?solo=1` (transport di memori, tanpa jaringan).

### Uji coba dua device di jaringan lokal
```bash
npm run dev                       # sudah bind 0.0.0.0:3000
# cari IP komputer, mis. 192.168.1.10
# Device 1: http://192.168.1.10:3000
# Device 2: buka link undangan dari pemain 1
```
> `localhost` di HP menunjuk ke HP itu sendiri — pakai IP komputer.

---

## Deploy ke Vercel

**Cara 1 — lewat GitHub (paling mudah):**
```bash
git init && git add . && git commit -m "catur online next.js"
git remote add origin https://github.com/<akun>/<repo>.git
git push -u origin main
```
Lalu di [vercel.com](https://vercel.com): **Add New → Project → Import** repo tersebut →
**Deploy**. Tidak ada environment variable, tidak ada database yang perlu disiapkan.

**Cara 2 — lewat CLI:**
```bash
npm i -g vercel
vercel          # deploy preview
vercel --prod   # deploy produksi
```

Setelah dapat URL (mis. `https://catur-online-anda.vercel.app`), pemain 1 membuat room lalu
mengirim link `https://.../r/<kode>` ke pemain 2. Selesai — bisa beda kota, beda jaringan.

> Pastikan repo tidak meng-commit `node_modules` / `.next` — sudah diatur di `.gitignore`.
> `vercel.json` disertakan seadanya (framework nextjs), jadi Vercel langsung mengenali proyek.

---

## Fitur

- Aturan catur lengkap: castling, en passant, promosi (dialog pilih bidak), skak, skakmat,
  stalemate, aturan 50 langkah, pengulangan posisi 3×, seri materi tidak cukup.
- Papan digambar manual dengan **glyph teks** (bukan emoji) → tampil konsisten di semua OS;
  warna petak sesuai standar (a1 gelap, h1 terang); papan **berbalik otomatis** untuk Hitam.
- Klik-untuk-jalan **dan** seret-lepas (drag & drop).
- Jam 10 menit + 2 detik per langkah, dijeda saat lawan terputus; kemenangan/ kekalahan waktu otomatis.
- Riwayat ber-notasi SAN, penanda langkah terakhir, tanda skak merah di raja.
- Obrolan teks, tawaran damai (terima/tolak), menyerah, **rematch dengan warna ditukar**.
- Penonton: device ke-3 dan seterusnya bisa menyaksikan; bisa **mengambil kursi** bila
  pemain lama hilang lebih dari ±1 menit.
- Muat ulang / tutup tab aman: pemain kembali ke kursinya, papan ikut tersinkron ulang.
- Indikator koneksi (Tersambung / menyambung ulang / terputus) + nama broker yang dipakai.
- Suara langkah, skak, dan akhir permainan (bisa dimatikan).

---

## Pengujian

```bash
npm test                 # mesin + logika room (cepat, tanpa jaringan)
npm run test:browser     # 2 browser sungguhan (laptop + HP) lewat broker MQTT publik
```
`test:browser` butuh server jalan (`npm run build && npx next start -p 3100`).

| Rangkaian | Isi | Status |
|---|---|---|
| `tests/perft.ts` | perft hingga 197.281 posisi (Startpos, Kiwipete, posisi-3, promosi) + skenario nyata | ✅ lulus |
| `tests/room.test.ts` | 45 pemeriksaan dengan 3 device virtual: kursi, langkah silang, penolakan langkah ilegal, obrolan, **penyembuhan diri setelah pesan hilang**, penonton melihat posisi terkini, **reload kembali ke kursi**, jam & batas waktu (jam virtual), damai, menyerah, rematch tukar warna | ✅ lulus |
| `tests/browser-mqtt.test.ts` | 2 Chromium (1280×900 & 390×844) bermain lewat **broker publik EMQX**: buat/gabung room, langkah silang device, obrolan, reload, promosi penuh `cxd8=Q+`, penonton device ketiga, menyerah, rematch + warna ditukar | ✅ lulus |

Screenshot hasil uji: `screenshots/vercel-desktop.png`, `screenshots/vercel-mobile.png`.

Tiga bug nyata yang ketangkap uji ini (dan sudah diperbaiki):
1. `started` tidak dihitung ulang ketika kursi terisi sebelum koneksi broker siap → overlay "menunggu lawan" tak pernah hilang di satu device.
2. Gerbang `ply` yang terlalu ketat membuat pemain yang bergabung di awal game tidak pernah menerima snapshot → papan kosong setelah reload.
3. Tembolok "kirim snapshot" membuang permintaan (bukan menundanya) saat dua permintaan datang berdekatan → lawan tidak pernah tersinkron.

---

## Batasan yang perlu kamu tahu (jujur)

- **Bukan anti-curang.** Karena aturan dijalankan di klien, orang yang paham teknis bisa
  memodifikasi halamannya. Ini pola yang sama dengan game kasual berbasis P2P; cocok untuk
  main santai, bukan turnamen berhadiah.
- **Bergantung pada broker publik.** EMQX/HiveMQ gratis dan cukup andal, tapi bisa saja
  lambat/diblokir di jaringan tertentu (mis. WiFi kantor). Ada failover otomatis ke broker
  kedua, dan indikator koneksi memberi tahu bila sedang bermasalah.
- **Privasi:** pesan lewat broker publik. Kode room 8 karakter acak (sulit ditebak), tapi
  jangan kirim informasi sensitif di obrolan. Siapa pun yang tahu kode bisa menonton.
- **Room tidak permanen.** Tidak ada riwayat tersimpan; kalau kedua pemain menutup browser,
  pertandingan selesai.
- **Batas praktis:** broker publik membatasi laju pesan. Catur itu turn-based, jadi jauh
  dari batas — tapi jangan dipakai untuk ratusan penonton sekaligus.

## Kalau ingin lebih serius

1. **Broker sendiri** — jalankan EMQX/Mosquitto (tanpa database) lalu arahkan aplikasi
   ke sana tanpa mengubah kode:
   ```js
   localStorage.setItem('catur.brokers', JSON.stringify([
     { id: 'saya', label: 'Broker sendiri', url: 'wss://broker.domainmu.com:8084/mqtt' }
   ]));
   ```
2. **Anti-curang** — tambahkan validasi pihak ketiga (mis. layanan kecil ber-Postgres,
   atau WebSocket server sendiri). Ini otomatis kembali memakai pola versi `../catur-online`.
3. **Simpan riwayat** — tambahkan tombol ekspor PGN, atau simpan ke penyimpanan yang
   memang punya database (Vercel KV, Supabase) kalau nanti menginginkan leaderboard.

---

## Struktur proyek

```
app/
  layout.tsx            kerangka halaman (metadata, viewport)
  page.tsx              lobby: buat room / gabung pakai kode
  r/[code]/page.tsx     halaman permainan (meneruskan kode ke GameRoom)
  globals.css           seluruh gaya tampilan
components/
  GameRoom.tsx          papan + panel: jam, riwayat, obrolan, kendali, dialog promosi
  BoardView.tsx         papan (digambar manual, klik & drag-drop)
  useRoom.ts            hook React: membuat Room & berlangganan perubahannya
  sfx.ts                efek suara WebAudio (tanpa berkas aset)
lib/
  chess.ts              mesin catur (aturan lengkap, hasil konversi yang sudah lolos perft)
  room.ts               mesin state sisi klien: kursi, giliran, jam, resync, rematch
  transport.ts          MqttTransport (failover broker) + MemoryTransport (untuk tes)
  protocol.ts           konstanta & format pesan (topik, kontrol waktu, jenis pesan)
  identity.ts           pid & nama di localStorage (bukan database)
tests/                  perft + logika room + uji 2 browser lewat broker publik
```
