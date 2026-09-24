import { defMultiplier, effectivePierce, mdefMultiplier, type ArmorTarget } from '@sim';

/**
 * What differs between the physical and the magic chart. The curve is the
 * same function for both; only the physical one has been read in game, so
 * the magic one says it is borrowed.
 */
const TEXT = {
  def: {
    curve: 'Pierce from penetration',
    curveWhy: '100 × (1 − (1 − pen/100)³), fitted to five in-game readings between 5 and '
      + '53 penetration and exact at all five. Not checked above 53.',
    bars: 'Damage that gets through DEF',
    barsWhy: 'Assumes the renewal formula, damage × (4000 + DEF) / (4000 + DEF × 10), '
      + 'with pierce taking its share of the DEF first. Soft DEF (the VIT part) is not '
      + 'included. Not yet checked in game.',
    unit: 'DEF',
    through: defMultiplier,
  },
  mdef: {
    curve: 'Magic pierce from magic penetration',
    curveWhy: 'Assumed to follow the same curve as physical penetration, '
      + '100 × (1 − (1 − pen/100)³). Not read in game for magic at all.',
    bars: 'Magic damage that gets through MDEF',
    barsWhy: 'Assumes the renewal formula, damage × (1000 + MDEF) / (1000 + MDEF × 10), '
      + 'with pierce taking its share of the MDEF first. Soft MDEF (the INT part) is '
      + 'not included. Not yet checked in game.',
    unit: 'MDEF',
    through: mdefMultiplier,
  },
};

// Plot box inside the SVG's own coordinates; the SVG scales to the tooltip.
const W = 300;
const H = 132;
const LEFT = 34;
const RIGHT = 10;
const TOP = 10;
const BOTTOM = 20;
const PW = W - LEFT - RIGHT;
const PH = H - TOP - BOTTOM;

const x = (pen: number) => LEFT + (Math.min(100, pen) / 100) * PW;
const y = (pct: number) => TOP + (1 - pct / 100) * PH;

/** The curve itself, sampled once: it does not depend on the build. */
const CURVE = Array.from({ length: 101 }, (_, p) =>
  `${p === 0 ? 'M' : 'L'}${x(p).toFixed(1)},${y(effectivePierce(p)).toFixed(1)}`).join('');

/**
 * Penetration against the pierce it buys, and what that leaves of a hit on
 * soft and hard targets.
 *
 * Deliberately two things and no more: where the build sits on the curve,
 * and how much damage it still loses to DEF. A long bar everywhere says
 * penetration is not the problem; a short one on the hard targets says it
 * is. Anything finer -- the worth of the next point, of each card -- is a
 * table to decipher rather than a decision to make.
 *
 * Lives in a hover, which the pointer can never enter, so there is no
 * crosshair: the current figure is written on the chart instead.
 */
export function PierceChart({ kind, pen, targets }: {
  /** Physical (DEF Penetration) or magic (MDEF Penetration). */
  kind: 'def' | 'mdef';
  pen: number;
  /** Monster DEF or MDEF figures to judge it against; null if the file is missing. */
  targets: ArmorTarget[] | null;
}) {
  const text = TEXT[kind];
  const now = effectivePierce(pen);
  const shown = Math.floor(now);
  const cx = x(pen);
  const cy = y(now);
  // The curve rises and flattens, so below and right of the dot is always
  // clear of it -- until the dot is near the right edge, where the label
  // goes left instead, and there the curve is flat so below is still clear.
  const labelLeft = W - RIGHT - cx < 90;

  return (
    <div className="pierce">
      <div className="pierce-sub">
        {text.curve}
        <span className="pierce-flag" title={text.curveWhy}>
          unverified
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img"
        aria-label={`${text.curve}: ${shown}% at ${pen}`}>
        {[0, 50, 100].map((v) => (
          <g key={v}>
            <line x1={LEFT} x2={W - RIGHT} y1={y(v)} y2={y(v)} className="pierce-grid" />
            <text x={LEFT - 6} y={y(v)} className="pierce-tick" textAnchor="end"
              dominantBaseline="middle">{v}%</text>
          </g>
        ))}
        {[0, 25, 50, 75, 100].map((v) => (
          <text key={v} x={x(v)} y={H - 6} className="pierce-tick" textAnchor="middle">{v}</text>
        ))}
        <line x1={cx} x2={cx} y1={cy} y2={y(0)} className="pierce-guide" />
        <line x1={LEFT} x2={cx} y1={cy} y2={cy} className="pierce-guide" />
        <path d={CURVE} className="pierce-line" />
        <circle cx={cx} cy={cy} r={4} className="pierce-dot" />
        <text x={labelLeft ? cx - 8 : cx + 8} y={Math.min(cy + 15, y(0) - 3)}
          className="pierce-label" textAnchor={labelLeft ? 'end' : 'start'}>
          {pen} pen → {shown}%
        </text>
      </svg>

      {targets && targets.length > 0 && (
        <>
          <div className="pierce-sub">
            {text.bars}
            <span className="pierce-flag" title={text.barsWhy}>
              unverified
            </span>
          </div>
          <div className="pierce-bars">
            {targets.map((t) => {
              const through = text.through(t.value, now) * 100;
              return (
                <div className="pierce-bar" key={t.label}
                  title={t.name ? `${t.name}, Lv ${t.level}`
                    : `Mean over ${t.count} kinds of monster that spawn`}>
                  <span className="pierce-bar-label">
                    {t.label} <em>{t.value} {text.unit}</em>
                  </span>
                  <span className="pierce-bar-track">
                    <span style={{ width: `${through}%` }} />
                  </span>
                  <span className="pierce-bar-value">{Math.floor(through)}%</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
