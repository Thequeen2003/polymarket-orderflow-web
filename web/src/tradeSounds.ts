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

/** Only play the two-tone fill chime on confirmed fills — not "sent", "armed", or cancel acks. */
export function okMsgIsExchangeFill(msg: string): boolean {
  const m = msg.trim().toLowerCase();
  if (!m) return false;
  if (
    m.includes('confirming') ||
    m.includes('reading exchange') ||
    m.includes('waiting') ||
    m.includes('sent ·') ||
    m.includes('buy sent') ||
    m.includes('sell sent') ||
    m.includes('bid placed') ||
    m.includes('armed from') ||
    m.includes('auto-arm') ||
    m.includes('cancel') ||
    m.includes('practice') ||
    m.includes('reset')
  ) {
    return false;
  }
  if (m.includes('exchange confirmed')) return true;
  if (m.startsWith('filled ·')) return true;
  if ((m.includes('bought') || m.includes('sold')) && m.includes('@') && m.includes('¢')) return true;
  if (m.includes('paper filled') || m.includes('paper stop-loss') || m.includes('paper take-profit')) return true;
  return false;
}
