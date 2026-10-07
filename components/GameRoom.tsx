'use client';
/*
 * Layar permainan: papan, jam, riwayat, obrolan, dan kendali permainan.
 * Semua data mengalir dari Room (di sisi klien) — server Vercel hanya menyajikan
 * halaman ini sebagai file statis, tanpa menyimpan state apa pun.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import * as E from '../lib/chess';
import { BASE_TIME } from '../lib/protocol';
import type { PublicState, ChatEntry } from '../lib/room';
import { useRoom } from './useRoom';
import BoardView, { GLYPH } from './BoardView';
import { sfx, toggleSound, soundEnabled } from './sfx';

const sideName = (c: 'w' | 'b') => (c === 'w' ? 'Putih' : 'Hitam');
const fmtClock = (ms: number) => {
  ms = Math.max(0, Math.floor(ms));
  const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
  return m + ':' + String(s).padStart(2, '0');
};

export default function GameRoom({ code, preferSide }: { code: string; preferSide?: 'w' | 'auto' }) {
  const { room, state } = useRoom({ code, name: '', preferSide });
  const [selected, setSelected] = useState<number | null>(null);
  const [promo, setPromo] = useState<{ from: number; to: number } | null>(null);
  const [chatText, setChatText] = useState('');
  const [inviteCopied, setInviteCopied] = useState(false);
  const [sound, setSound] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const chatBoxRef = useRef<HTMLDivElement>(null);
  const movesRef = useRef<HTMLDivElement>(null);
  const prevPly = useRef(0);
  const prevStatus = useRef<string>('playing');

  useEffect(() => { setSound(soundEnabled()); }, []);

  // tampilkan pesan kesalahan sebentar (mis. langkah ditolak karena sinkronisasi ulang)
  useEffect(() => {
    if (!state?.lastError) return;
    setNotice(state.lastError);
    room?.setError(null);
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [state?.lastError, room]);

  const engine = useMemo(() => (state ? E.parseFen(state.fen) : null), [state?.fen]);

  const targets = useMemo(() => {
    if (!room || selected === null || !engine) return new Set<number>();
    return new Set(room.legalTargets(selected));
  }, [room, selected, state?.fen, state?.turn]);

  // efek suara
  useEffect(() => {
    if (!state) return;
    const ply = state.history.length;
    if (ply > prevPly.current) sfx.move();
    if (state.inCheck && prevPly.current !== ply) sfx.check();
    prevPly.current = ply;
    const s = state.status.type;
    if (s !== 'playing' && prevStatus.current === 'playing') sfx.end();
    prevStatus.current = s;
  }, [state?.history.length, state?.status.type]);

  // gulir otomatis
  useEffect(() => { if (chatBoxRef.current) chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight; }, [state?.chat.length]);
  useEffect(() => { if (movesRef.current) movesRef.current.scrollTop = movesRef.current.scrollHeight; }, [state?.history.length]);

  useEffect(() => {
    setSelected(null);
  }, [state?.fen]);

  const tryMove = useCallback((from: number, to: number) => {
    if (!room) return;
    if (room.isPromotion(from, to)) { setPromo({ from, to }); return; }
    const res = room.move(from, to);
    if (!res.ok && res.error) room.setError(res.error);
    setSelected(null);
  }, [room]);

  const onSquare = useCallback((idx: number) => {
    if (!room || !state || !engine) return;
    const myRole = state.myRole;
    if (myRole !== 'w' && myRole !== 'b') return;
    const piece = engine.board[idx];
    if (selected !== null && targets.has(idx)) { tryMove(selected, idx); return; }
    if (piece && E.colorOf(piece) === myRole) {
      if (!room.canMoveNow()) {
        // papan kita mungkin tertinggal — minta sinkronisasi & beri tahu pemain
        room.nudge();
        room.setError(state.status.type === 'playing' ? 'Menyelaraskan papan… coba lagi sebentar.' : 'Bukan giliranmu.');
        return;
      }
      setSelected(idx === selected ? null : idx);
      return;
    }
    setSelected(null);
  }, [room, state, engine, selected, targets, tryMove]);

  if (!state || !engine) {
    return (
      <div className="loading">
        <div className="brand-icon">♞</div>
        <p>Menyiapkan papan…</p>
      </div>
    );
  }

  const inviteLink = typeof window !== 'undefined' ? window.location.origin + '/r/' + code : '/r/' + code;
  const over = state.status.type !== 'playing';
  const mySeat = state.myRole === 'w' || state.myRole === 'b';

  const copyInvite = async () => {
    try {
      await navigator.clipboard.writeText(inviteLink);
      setInviteCopied(true);
      setTimeout(() => setInviteCopied(false), 2500);
    } catch {
      window.prompt('Salin link undangan ini:', inviteLink);
    }
  };

  const netLabel: Record<string, string> = {
    idle: '● Menyiapkan…', connecting: '● Menyambung…', online: '● Tersambung',
    reconnecting: '● Menyambung ulang…', offline: '● Terputus',
  };
  const netCls = state.net === 'online' ? 'ok' : state.net === 'offline' ? 'bad' : 'warn';

  const rows: { n: number; w?: typeof state.history[0]; b?: typeof state.history[0] }[] = [];
  state.history.forEach((h, i) => {
    const n = Math.floor(i / 2) + 1;
    if (i % 2 === 0) rows.push({ n, w: h });
    else (rows[rows.length - 1] || rows.push({ n })) && (rows[rows.length - 1].b = h);
  });

  const lastPly = state.history.length - 1;

  return (
    <div className="game-shell">
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand-icon small">♞</span>
          <span className="room-code"><span className="label">Room</span><b data-testid="room-code">{code}</b></span>
        </div>
        <div className="topbar-right">
          <span className={'badge ' + netCls} title={state.netDetail || ''}>{netLabel[state.net] || state.net}</span>
          <span className="badge soft" hidden={state.spectators === 0}>{state.spectators} penonton</span>
          <button className="btn small" onClick={copyInvite}>
            {inviteCopied ? 'Tersalin!' : (<><span className="wide-only">Salin Link Undangan</span><span className="narrow-only">Undang</span></>)}
          </button>
          <Link className="btn small ghost" href="/">Keluar</Link>
        </div>
      </header>

      <main className="layout">
        <div className="board-column">
          {(['b', 'w'] as const).map(side => (
            <React.Fragment key={side}>
              <div className={'pbar' + (state.status.type === 'playing' && state.turn === side ? ' active' : '') + (state.clock[side] < 20000 ? ' low' : '')} data-side={side}>
                <span className={'dot ' + (state.seats[side] ? (state.seats[side]!.present ? 'on' : 'off') : '')} />
                <span className="pname">
                  {state.seats[side] ? state.seats[side]!.name : sideName(side) + ' — kosong'}
                  {state.myRole === side ? <span className="muted"> (kamu)</span> : null}
                </span>
                {state.status.type === 'playing' && state.turn === side ? <span className="turn">●</span> : null}
                <span className="clock" data-testid={'clock-' + side}>{fmtClock(state.clock[side])}</span>
              </div>
              {side === 'b' && (
                <div className="board-wrap">
                  <BoardView state={state} engine={engine} selected={selected} targets={targets} onSquare={onSquare} onDrop={tryMove} />
                  {(!state.started || !state.seats.b || !state.seats.w) && !over && (
                    <div className="board-overlay" data-testid="overlay-wait">
                      <div className="ov-inner">
                        <p className="ov-title">Menunggu pemain kedua…</p>
                        <p className="ov-sub">Kirim kode atau link undangan ini ke lawanmu</p>
                        <div className="ov-code">{code}</div>
                        <button className="btn primary" onClick={copyInvite}>{inviteCopied ? 'Tersalin!' : 'Salin Link Undangan'}</button>
                      </div>
                    </div>
                  )}
                  {state.net === 'offline' && (
                    <div className="board-overlay">
                      <div className="ov-inner">
                        <p className="ov-title">Terputus dari jaringan</p>
                        <p className="ov-sub">Sedang mencoba menyambung ulang ke broker…</p>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </React.Fragment>
          ))}
          <p className="hint" data-testid="seat-info">
            {mySeat
              ? 'Kamu bermain sebagai ' + sideName(state.myRole as 'w' | 'b') + (state.started ? '' : ' — tunggu lawan bergabung')
              : 'Kamu menonton. Buka link yang sama dari device lain untuk ikut bermain.'}
          </p>
        </div>

        <aside className="panel">
          <div className={'status ' + (over ? 'over' : state.inCheck ? 'check' : mySeat && state.turn === state.myRole ? '' : 'muted-s')} data-testid="status">
            {statusText(state, mySeat)}
          </div>

          {state.freeSeats.length > 0 && !mySeat && (
            <div className="offer">
              <span>Ada kursi kosong (pemain lama tidak kembali).</span>
              {state.freeSeats.map(s => (
                <button key={s} className="btn small primary" onClick={() => room?.claimSeat(s)}>Ambil {sideName(s)}</button>
              ))}
            </div>
          )}

          <div className="card grow">
            <div className="card-head">
              <h2>Riwayat Langkah</h2>
              <span className="muted" data-testid="ply-count">{state.history.length} langkah</span>
            </div>
            <div className="moves" ref={movesRef} data-testid="moves">
              {state.history.length === 0 && <p className="muted pad">Belum ada langkah.</p>}
              {rows.map((row, ri) => (
                <div className="ply" key={ri}>
                  <span className="n">{row.n}.</span>
                  <span className={'san' + (row.w && (ri * 2) === lastPly ? ' last' : '')}>{row.w?.san || ''}</span>
                  <span className={'san' + (row.b && (ri * 2 + 1) === lastPly ? ' last' : '')}>{row.b?.san || ''}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="actions">
            <button className="btn" disabled={over || !mySeat || state.drawOffer === state.myRole}
              onClick={() => room?.offerDraw()} data-testid="btn-draw">Tawarkan Damai</button>
            <button className="btn danger" disabled={over || !mySeat}
              onClick={() => { if (window.confirm('Yakin menyerah? Permainan langsung berakhir.')) room?.resign(); }}
              data-testid="btn-resign">Menyerah</button>
            {over && (
              <button className="btn primary" disabled={!mySeat || state.rematch.mine}
                onClick={() => room?.voteRematch()} data-testid="btn-rematch">
                {state.rematch.mine ? 'Menunggu lawan…' : '↻ Rematch'}
              </button>
            )}
            <button className="btn ghost small" onClick={() => setSound(toggleSound())} data-testid="btn-sound">
              {sound ? 'Suara: On' : 'Suara: Off'}
            </button>
          </div>

          {state.drawOffer && state.drawOffer !== state.myRole && (
            <div className="offer" data-testid="offer-bar">
              <span>{sideName(state.drawOffer)} menawarkan damai.</span>
              <button className="btn primary small" onClick={() => room?.acceptDraw()}>Terima</button>
              <button className="btn small ghost" onClick={() => room?.declineDraw()}>Tolak</button>
            </div>
          )}

          <div className="card chat-card">
            <div className="card-head"><h2>Obrolan</h2></div>
            <div className="chat" ref={chatBoxRef} data-testid="chat">
              {state.chat.map((c: ChatEntry) => (
                <div className={'msg' + (c.pid === state.myPid ? ' me' : '')} key={c.id}>
                  <span className="who">{c.name}:</span> {c.text}
                </div>
              ))}
            </div>
            <form className="chat-form" onSubmit={e => { e.preventDefault(); if (chatText.trim()) { room?.sendChat(chatText); setChatText(''); } }}>
              <input value={chatText} onChange={e => setChatText(e.target.value)} maxLength={300} placeholder="Tulis pesan…" data-testid="chat-input" />
              <button className="btn small primary" type="submit">Kirim</button>
            </form>
          </div>
        </aside>
      </main>

      {notice && <div className="toast" data-testid="notice">{notice}</div>}

      {promo && (
        <div className="overlay" data-testid="promo">
          <div className="promo-box">
            <p>Promosi bidak jadi apa?</p>
            <div className="promo-choices">
              {(['q', 'r', 'b', 'n'] as const).map(t => (
                <button key={t} data-testid={'promo-' + t}
                  onClick={() => { room?.move(promo.from, promo.to, t); setPromo(null); setSelected(null); }}>
                  <span className={'piece ' + (state.myRole === 'b' ? 'b' : 'w')}>{GLYPH[t]}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function statusText(s: PublicState, mySeat: boolean): string {
  const st = s.status as any;
  switch (st.type) {
    case 'checkmate': return 'Pemenang: ' + sideName(st.winner) + ' — skakmat';
    case 'stalemate': return 'Seri — stalemate (tidak ada langkah legal)';
    case 'resign': return 'Pemenang: ' + sideName(st.winner) + ' — lawan menyerah';
    case 'timeout': return 'Pemenang: ' + sideName(st.winner) + ' — ' + st.reason;
    case 'draw-agreed': return 'Seri — damai disepakati';
    case 'draw': return 'Seri — ' + st.reason;
    case 'repetition': return 'Seri — ' + st.reason;
    case 'insufficient': return 'Seri — materi tidak cukup';
  }
  if (!s.seats.w || !s.seats.b) return 'Menunggu pemain kedua…';
  if (s.inCheck) return 'Skak! Giliran ' + sideName(s.turn) + ' menyelamatkan raja';
  if (!mySeat) return 'Kamu menonton. Giliran ' + sideName(s.turn) + '.';
  if (s.turn === s.myRole) return 'Giliranmu — jalan sekarang';
  return 'Menunggu lawan jalan…';
}
