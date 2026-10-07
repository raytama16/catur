'use client';
/* Efek suara ringan memakai WebAudio — tanpa file aset. */

let soundOn = true;
if (typeof window !== 'undefined') {
  try { soundOn = window.localStorage.getItem('catur.sound') !== '0'; } catch { /* abaikan */ }
}
let ctx: AudioContext | null = null;

function beep(freq: number, dur: number, type: OscillatorType = 'triangle', vol = 0.05) {
  if (!soundOn || typeof window === 'undefined') return;
  try {
    const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    if (!AC) return;
    ctx = ctx || new AC();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    const t = ctx.currentTime;
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(ctx.destination);
    o.start(t); o.stop(t + dur + 0.03);
  } catch { /* audio tidak tersedia / diblokir autoplay */ }
}

export const sfx = {
  move: () => beep(300, 0.07, 'square', 0.045),
  check: () => { beep(880, 0.11); setTimeout(() => beep(1150, 0.13), 120); },
  end: () => { beep(660, 0.15); setTimeout(() => beep(520, 0.18), 160); setTimeout(() => beep(392, 0.25), 330); },
};

export function soundEnabled() { return soundOn; }
export function toggleSound(): boolean {
  soundOn = !soundOn;
  try { window.localStorage.setItem('catur.sound', soundOn ? '1' : '0'); } catch { /* abaikan */ }
  if (soundOn) beep(600, 0.08);
  return soundOn;
}
