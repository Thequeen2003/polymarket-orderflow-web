import { useMemo, type ReactElement } from 'react';
import { PtbOpportunityModeChart } from './PtbOpportunityModeChart';
import type { SpotPoint } from './SpotLevelChart';

type Row = {
  label: string;
  spot: SpotPoint[];
  ptb: number | null;
  endsInMs: number | null;
  lastUpdateMs: number | null;
};

function laneFor(spot: SpotPoint[], ptb: number | null): 'up' | 'down' {
  if (ptb == null || spot.length < 1) return 'up';
  const last = spot[spot.length - 1]!.v;
  return last >= ptb ? 'up' : 'down';
}

export function PtbThreeUp(props: { rows: Row[] }): ReactElement {
  const { rows } = props;
  const clean = useMemo(() => rows.filter((r) => r.label), [rows]);

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      {clean.map((r) => (
        <div key={r.label} className="min-w-0">
          <PtbOpportunityModeChart
            mode={laneFor(r.spot, r.ptb)}
            spot={r.spot}
            priceToBeat={r.ptb}
            lastUpdateMs={r.lastUpdateMs}
            endsInMs={r.endsInMs}
            chartTitle={r.label}
            upLabel="UP"
            downLabel="DOWN"
          />
        </div>
      ))}
    </div>
  );
}

