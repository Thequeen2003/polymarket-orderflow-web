import { bullpenOutcomeForOrder } from './bullpenOutcome';

/** Outcome string for live sells — prefer bracket-armed lane over visible tab. */
export function resolveLiveSellOutcome(args: {
  lane: 'up' | 'down';
  marketSlug?: string | null;
  label: string;
  bracketLane: 'up' | 'down' | null;
  bracketToken: string | null;
  activeToken: string | null;
  upLabel: string;
  downLabel: string;
}): string {
  const active = args.activeToken?.trim() ?? '';
  const bracketTok = args.bracketToken?.trim() ?? '';
  const useBracket = bracketTok.length > 0 && active.length > 0 && bracketTok === active && args.bracketLane != null;
  const lane = useBracket ? args.bracketLane! : args.lane;
  const label = lane === 'up' ? args.upLabel : args.downLabel;
  return bullpenOutcomeForOrder({ lane, marketSlug: args.marketSlug, label });
}
