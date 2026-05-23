/**
 * Tiny WebAudio chime for full-screen structural alerts. Generates a two-tone bleep procedurally
 * so we don't ship an MP3. Browser autoplay policy requires the AudioContext to
 * be unlocked by a user gesture first — we lazily create it on the first call
 * and silently no-op if creation fails.
 *
 * Different kinds get different sounds so the user can distinguish without
 * looking at the screen:
 *   TRIPLE_CONFIRM_ENTRY → ascending major third (E5 → G#5)
 *   EXIT_NOW             → descending tritone (A5 → D#5) — uneasy alert
 *   OPPOSITE_INCOMING    → quick double tap at A5
 */

type ChimeKind = 'TRIPLE_CONFIRM_ENTRY' | 'EXIT_NOW' | 'OPPOSITE_INCOMING';

type ChimeWindow = Window & {
  webkitAudioContext?: typeof AudioContext;
};

let ctx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (ctx) return ctx;
  try {
    const w = window as ChimeWindow;
    const Ctor = window.AudioContext ?? w.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    return ctx;
  } catch {
    return null;
  }
}

function playTone(audioCtx: AudioContext, freq: number, startAt: number, durationSec: number, gain = 0.07): void {
  const osc = audioCtx.createOscillator();
  const g = audioCtx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freq;
  // Quick attack/release so it doesn't click.
  g.gain.setValueAtTime(0, startAt);
  g.gain.linearRampToValueAtTime(gain, startAt + 0.015);
  g.gain.linearRampToValueAtTime(0, startAt + durationSec);
  osc.connect(g);
  g.connect(audioCtx.destination);
  osc.start(startAt);
  osc.stop(startAt + durationSec + 0.05);
}

export function playBoomChime(kind: ChimeKind): void {
  const audioCtx = getCtx();
  if (!audioCtx) return;
  // Some browsers leave the ctx in suspended state until a gesture; skip silently.
  if (audioCtx.state === 'suspended') {
    void audioCtx.resume().catch(() => undefined);
  }
  const t = audioCtx.currentTime + 0.01;
  switch (kind) {
    case 'TRIPLE_CONFIRM_ENTRY': {
      playTone(audioCtx, 659.25, t, 0.18); // E5
      playTone(audioCtx, 830.61, t + 0.16, 0.22); // G#5
      break;
    }
    case 'EXIT_NOW': {
      playTone(audioCtx, 880.0, t, 0.18); // A5
      playTone(audioCtx, 622.25, t + 0.18, 0.22, 0.085); // D#5 (tritone, slightly louder)
      break;
    }
    case 'OPPOSITE_INCOMING': {
      playTone(audioCtx, 880.0, t, 0.1);
      playTone(audioCtx, 880.0, t + 0.13, 0.1);
      break;
    }
  }
}

/**
 * Best-effort prime — call inside a user click handler to unlock audio without
 * playing anything audible. Safe to call repeatedly.
 */
export function primeBoomChime(): void {
  const audioCtx = getCtx();
  if (!audioCtx) return;
  if (audioCtx.state === 'suspended') {
    void audioCtx.resume().catch(() => undefined);
  }
}
