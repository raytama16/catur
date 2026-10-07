/*
 * Identitas & sesi — disimpan di localStorage browser (bukan database).
 * pid   : nama acak yang menempel di kursi (Putih/Hitam) sepanjang pertandingan.
 * name  : nama tampilan yang diisi pemain.
 * Sesi ini juga yang membuat pemain kembali ke kursinya setelah muat ulang.
 */
import { newId } from './protocol';

const PID_KEY = 'catur.pid';
const NAME_KEY = 'catur.name';
const SEAT_KEY = (code: string) => 'catur.seat.' + code;
const SNIPPET_KEY = (code: string) => 'catur.seat.' + code + '.pending';

function safeGet(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function safeSet(key: string, value: string) {
  try { window.localStorage.setItem(key, value); } catch { /* mode privat: abaikan */ }
}
function safeDel(key: string) {
  try { window.localStorage.removeItem(key); } catch { /* abaikan */ }
}

/** Satu pid per browser — dipakai untuk semua room. */
export function getPid(): string {
  if (typeof window === 'undefined') return 'server';
  let pid = safeGet(PID_KEY);
  if (!pid) { pid = newId().slice(0, 12); safeSet(PID_KEY, pid); }
  return pid;
}

export function getSavedName(): string { return safeGet(NAME_KEY) || ''; }
export function saveName(name: string) { safeSet(NAME_KEY, name); }

/** Kursi yang pernah dipakai di room ini (untuk kembali setelah reload). */
export function getSavedSeat(code: string): 'w' | 'b' | null {
  const v = safeGet(SEAT_KEY(code));
  return v === 'w' || v === 'b' ? v : null;
}
export function saveSeat(code: string, side: 'w' | 'b') { safeSet(SEAT_KEY(code), side); }
export function clearSeat(code: string) { safeDel(SEAT_KEY(code)); }

/** Niat mengambil kursi Putih saat membuat room (sekali pakai). */
export function markPendingSeat(code: string) { safeSet(SNIPPET_KEY(code), 'w'); }
export function consumePendingSeat(code: string): 'w' | null {
  if (safeGet(SNIPPET_KEY(code)) === 'w') { safeDel(SNIPPET_KEY(code)); return 'w'; }
  return null;
}
