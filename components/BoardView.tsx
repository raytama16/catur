'use client';
/*
 * Papan catur — digambar manual (tanpa aset/emoji agar tampil sama di semua OS).
 * Aturan warna: a1 gelap, h1 terang (standar catur). Papan dibalik untuk Hitam.
 */
import React from 'react';
import * as E from '../lib/chess';
import type { PublicState } from '../lib/room';

/** Glyph bidak gaya "teks" (bukan emoji) supaya konsisten di berbagai perangkat. */
export const GLYPH: Record<string, string> = {
  k: '\u265A\uFE0E', q: '\u265B\uFE0E', r: '\u265C\uFE0E',
  b: '\u265D\uFE0E', n: '\u265E\uFE0E', p: '\u265F\uFE0E',
};

interface BoardProps {
  state: PublicState;
  engine: E.ChessState;
  selected: number | null;
  targets: Set<number>;
  onSquare: (idx: number) => void;
  onDrop?: (from: number, to: number) => void;
}

export default function BoardView({ state, engine, selected, targets, onSquare, onDrop }: BoardProps) {
  const flip = state.myRole === 'b';
  const order: number[] = [];
  for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
    order.push(flip ? (7 - r) * 8 + (7 - f) : r * 8 + f);
  }

  const last = state.lastMove;
  const checkSq = state.inCheck ? E.kingSquare(engine, state.turn) : null;
  const myTurnNow = state.status.type === 'playing' && (state.myRole === 'w' || state.myRole === 'b') && state.turn === state.myRole;

  const dragFrom = React.useRef<number | null>(null);

  return (
    <div className="board" id="board">
      {order.map((idx, vi) => {
        const piece = engine.board[idx];
        const isLight = ((idx >> 3) + (idx & 7)) % 2 === 0;   // a1 gelap, h1 terang
        const cls = ['sq', isLight ? 'light' : 'dark'];
        if (last && (last.from === idx || last.to === idx)) cls.push('last');
        if (selected === idx) cls.push('sel');
        if (checkSq === idx) cls.push('check');
        if (myTurnNow && piece && E.colorOf(piece) === state.myRole) cls.push('mine');
        if (targets.has(idx)) cls.push(piece ? 'hint-cap' : 'hint-dot');

        const r = idx >> 3, f = idx & 7;
        const isBottomRow = flip ? r === 0 : r === 7;
        const isLeftCol = flip ? f === 7 : f === 0;

        return (
          <div
            key={vi}
            className={cls.join(' ')}
            data-sq={idx}
            onClick={() => onSquare(idx)}
            draggable={!!(myTurnNow && piece && E.colorOf(piece) === state.myRole)}
            onDragStart={() => { dragFrom.current = idx; }}
            onDragOver={e => { if (dragFrom.current !== null) e.preventDefault(); }}
            onDrop={e => {
              e.preventDefault();
              const from = dragFrom.current;
              dragFrom.current = null;
              if (from !== null && from !== idx && onDrop) onDrop(from, idx);
            }}
          >
            {piece && (
              <span className={'piece ' + E.colorOf(piece)}>
                {GLYPH[E.typeOf(piece)]}
              </span>
            )}
            {isBottomRow && <span className="coord f">{E.FILES[f]}</span>}
            {isLeftCol && <span className="coord r">{8 - r}</span>}
          </div>
        );
      })}
    </div>
  );
}
