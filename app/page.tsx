'use client';
/*
 * Lobby — pemain membuat room (langsung dapat kursi Putih) atau gabung pakai kode.
 * Semua identitas disimpan di localStorage; tidak ada database, tidak ada akun.
 */
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { makeRoomCode, isValidRoomCode, DEFAULT_BROKERS } from '../lib/protocol';
import { getSavedName, markPendingSeat, saveName } from '../lib/identity';

export default function Home() {
  const router = useRouter();
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);

  useEffect(() => { setName(getSavedName()); setReady(true); }, []);

  const createRoom = () => {
    const clean = name.trim().slice(0, 20) || 'Pemain 1';
    saveName(clean);
    const roomCode = makeRoomCode();
    markPendingSeat(roomCode);
    router.push('/r/' + roomCode + '?seat=w');
  };

  const joinRoom = () => {
    const clean = name.trim().slice(0, 20) || 'Pemain 2';
    saveName(clean);
    const c = code.trim().toLowerCase();
    if (!isValidRoomCode(c)) { setError('Kode room tidak valid (contoh: k7m2pq4a).'); return; }
    router.push('/r/' + c);
  };

  return (
    <section className="home">
      <div className="home-card">
        <div className="brand">
          <span className="brand-icon">♞</span>
          <div>
            <h1>Catur Online</h1>
            <p className="tagline">
              Main berdua dari dua device berbeda — <b>tanpa database</b>, tanpa akun.
              Halaman ini statis; permainan mengalir langsung antar-browser lewat broker publik.
            </p>
          </div>
        </div>

        <label className="field">
          <span>Nama kamu</span>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            maxLength={20}
            placeholder="mis. Budi"
            autoComplete="nickname"
            data-testid="in-name"
            disabled={!ready}
          />
        </label>

        <button className="btn primary big" onClick={createRoom} data-testid="btn-create">
          <span>Buat Room Baru</span>
          <small>kamu jadi Putih, lawan tinggal masuk pakai kode</small>
        </button>

        <div className="divider"><span>atau gabung room</span></div>

        <div className="join-row">
          <input
            value={code}
            onChange={e => setCode(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') joinRoom(); }}
            maxLength={24}
            placeholder="KODE ROOM"
            autoCapitalize="characters"
            spellCheck={false}
            data-testid="in-code"
          />
          <button className="btn" onClick={joinRoom} data-testid="btn-join">Gabung</button>
        </div>
        {error && <p className="error">{error}</p>}

        <details className="how">
          <summary>Cara main & catatan teknis</summary>
          <ol>
            <li>Pemain 1: isi nama → <b>Buat Room Baru</b> → dapat kode + link undangan.</li>
            <li>Kirim kode/link ke pemain 2 (WhatsApp dll).</li>
            <li>Pemain 2: buka link / masukkan kode → duduk sebagai <b>Hitam</b> → mulai.</li>
            <li>Pemain ke-3 dst. otomatis jadi penonton. Ada jam 10 menit + 2 detik/langkah.</li>
          </ol>
          <ul>
            <li><b>Tanpa database & tanpa server permainan.</b> Halaman ini di-hosting statis di
              Vercel; langkah pemain dikirim langsung antar-browser lewat broker MQTT publik
              (<a href="https://www.emqx.com/en/mqtt/public-mqtt5-broker" target="_blank" rel="noreferrer">{DEFAULT_BROKERS[0].label}</a>).
              Server Vercel tidak menyimpan apa pun.</li>
            <li>Kedua device memvalidasi langkah dengan mesin catur yang sama, jadi aturan tetap ditegakkan.</li>
            <li>Kalau broker sedang diblokir jaringan tempatmu, coba lagi atau pindah jaringan.</li>
          </ul>
        </details>

        <p className="muted small-note">
          Ingin mencoba tanpa jaringan sama sekali? Buka <code>/r/&lt;kode&gt;?solo=1</code>.
        </p>
      </div>
    </section>
  );
}
