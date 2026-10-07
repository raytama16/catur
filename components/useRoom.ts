'use client';
/*
 * Hook React untuk menyambungkan komponen ke satu Room.
 * Room dibuat sekali (client-side), lalu komponen berlangganan snapshot-nya.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Room, PublicState } from '../lib/room';
import { MqttTransport, MemoryTransport } from '../lib/transport';
import { consumePendingSeat, getPid, getSavedName, getSavedSeat, saveName, saveSeat } from '../lib/identity';

export interface UseRoomOptions {
  code: string;
  name: string;
  /** 'w' = pembuat room (langsung ambil Putih); 'auto' = pilih otomatis. */
  preferSide?: 'w' | 'auto';
}

export function useRoom(opts: UseRoomOptions) {
  const { code, name, preferSide = 'auto' } = opts;
  const [room, setRoom] = useState<Room | null>(null);
  const createdRef = useRef(false);

  useEffect(() => {
    if (createdRef.current || !code) return;
    createdRef.current = true;

    const pid = getPid();
    const displayName = (name || getSavedName() || 'Pemain').slice(0, 20);
    if (name) saveName(name);

    // Mode tanpa jaringan (berguna untuk mencoba UI): ?solo=1
    const solo = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('solo') === '1';
    const transport = solo ? new MemoryTransport('solo:' + code) : new MqttTransport(code, pid);
    if (transport instanceof MemoryTransport) transport.link(transport);

    // Kursi: (1) pembuat room → Putih, (2) pemain yang kembali setelah reload → kursi lamanya,
    // (3) selain itu biarkan sistem memilih otomatis.
    const saved = getSavedSeat(code);
    const prefer: 'w' | 'b' | 'auto' =
      preferSide === 'w' || consumePendingSeat(code) === 'w' ? 'w' : (saved || 'auto');
    const r = new Room({ roomId: code, pid, name: displayName, transport, preferSide: prefer });
    r.connect();
    setRoom(r);
    return () => { r.close(); setRoom(null); createdRef.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const subscribe = useCallback((cb: () => void) => (room ? room.subscribe(cb) : () => {}), [room]);
  const getSnapshot = useCallback((): PublicState | null => (room ? room.getState() : null), [room]);
  const state = useSyncExternalStore(subscribe, getSnapshot, () => null);

  // catat kursi yang sedang dipakai (untuk kembali setelah reload)
  useEffect(() => {
    if (state && code && (state.myRole === 'w' || state.myRole === 'b')) saveSeat(code, state.myRole);
  }, [state?.myRole, code]);

  return { room, state };
}
