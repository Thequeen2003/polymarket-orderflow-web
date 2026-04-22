/** Short UI ticks — optional; fails silently if audio is blocked. */

function beep(freq: number, durationMs: number, gain = 0.06): void {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    g.gain.value = gain;
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + durationMs / 1000);
    window.setTimeout(() => {
      try {
        ctx.close();
      } catch {
        /* ignore */
      }
    }, durationMs + 80);
  } catch {
    /* ignore */
  }
}

export function playTradeClick(): void {
  beep(880, 45, 0.05);
}

export function playTradeFill(): void {
  beep(660, 55, 0.07);
  window.setTimeout(() => beep(990, 70, 0.06), 60);
}

export function playTradeError(): void {
  beep(220, 120, 0.08);
}
