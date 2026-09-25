import { useEffect, useMemo } from 'react';
import {
  applyChanges, farmFor, type Build, type Dataset, type Goal, type Move, type PlanPaths,
} from '@sim';
import { LockedNote, MoveRow } from './GoalsPanel';

/**
 * What "Suggest changes" and "Find upgrades" found, over the build.
 *
 * Its own overlay rather than a list under the goals, for the same reason
 * as `GoalFocus`: each row is a full suggestion -- pieces, cards, refine,
 * every stat it moves -- and needs the picker's width, not a side panel's.
 *
 * Laid out as paths rather than one list. With goals still short there is
 * a plan: steps that build on each other towards the targets. With every
 * goal met there is nothing to close, so what is shown is every way
 * forward, each on its own -- the best swap for each slot, refines on what
 * is worn, better rolls, and what is out of reach but worth working
 * towards -- so an easy refine or a long-term sun helmet is never crowded
 * out by whatever happens to score highest.
 */
/** Nothing found yet: what the overlay shows before the first results land. */
const NONE: PlanPaths = {
  steps: [], near: [], refines: [], rolls: [], far: [], sides: [], farm: [], sets: [],
};

export function PlanOverlay({
  paths: found, searching, upgrading, dataset, build, goals, lockedSlots, onApply, onClose,
}: {
  /** What the search has found so far; null before anything has come back. */
  paths: PlanPaths | null;
  /** Still looking: more may appear below. */
  searching: boolean;
  /** Every goal was already met, so these are upgrades rather than fixes. */
  upgrading: boolean;
  dataset: Dataset;
  build: Build;
  goals: Goal[];
  lockedSlots: number;
  onApply: (moves: Move[]) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const paths = found ?? NONE;
  const { steps, near, refines, rolls, far, sides, farm, sets } = paths;
  // The build each step starts from, which is how it will be applied.
  const stepBuilds = useMemo(() => {
    const out: Build[] = [];
    let at = build;
    for (const move of steps) {
      out.push(at);
      at = applyChanges(at, move.changes, dataset);
    }
    return out;
  }, [steps, build, dataset]);

  const title = upgrading ? 'Upgrades' : 'Suggested changes';
  const nothing = [steps, near, refines, rolls, far, sides, farm, sets].every((l) => l.length === 0);
  const row = (move: Move, action: string, onRowApply: () => void, from: Build, farm = false,
    rolled = false) => (
    <MoveRow
      move={move}
      goals={goals}
      action={action}
      onApply={onRowApply}
      dataset={dataset}
      build={from}
      note={farm ? <FarmNote move={move} build={build} dataset={dataset} rolled={rolled} /> : undefined}
    />
  );

  return (
    <div className="overlay" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="picker focus" role="dialog" aria-modal="true" aria-label={title}>
        <div className="picker-head">
          <h3>{title}</h3>
          <span className="focus-sub">
            {upgrading ? 'raises a goal, lowers nothing you have' : 'towards the goals'}
          </span>
          <div className="spacer" />
          {steps.length > 1 && <button onClick={() => onApply(steps)}>Apply all steps</button>}
          <button onClick={onClose}>Close</button>
        </div>

        <div className="picker-list">
          {nothing && !searching && (
            <div className="loading">
              {upgrading
                ? 'Nothing within these options raises a goal without lowering another.'
                : 'Nothing within these options gets any closer.'}
              <div className="empty-note" style={{ marginTop: 6 }}>
                Loosening the class, level or refine options may help
                {lockedSlots > 0 && <LockedNote slots={lockedSlots} />}.
              </div>
            </div>
          )}

          <Path title="Worth target-farming" note={'A long way off for this build, but so far ahead '
            + 'of anything close by that it is worth going after on purpose.'}>
            {farm.map((move) => row(move, 'Equip', () => onApply([move]), build, true))}
          </Path>

          <Path title="Steps" note={steps.length > 1
            ? 'Each builds on the ones above, so they apply in order. A greedy plan: a good '
              + 'route, not a proof of the best build.' : undefined}>
            {steps.map((move, i) => row(move, i === 0 ? 'Apply' : 'Apply up to here',
              () => onApply(steps.slice(0, i + 1)), stepBuilds[i]))}
          </Path>

          <Path title="Within reach" note={'The best swap for each slot that this build could '
            + 'get next. Each is an alternative, measured from the build as it is.'}>
            {near.map((move) => row(move, 'Equip', () => onApply([move]), build))}
          </Path>

          <Path title="Other sets" note={'Sets worth finishing besides any taken above. A set '
            + 'is a bigger step than one swap, so the runners-up are here to choose between.'}>
            {sets.map((move) => row(move, 'Equip', () => onApply([move]), build, true))}
          </Path>

          <Path title="Sidegrades" note={'Trades: more of one goal for less of another, where '
            + 'what it gives outweighs what it takes. High-effort ones are marked and ranked lower.'}>
            {sides.map((move) => row(move, 'Equip', () => onApply([move]), build, !!move.highEffort))}
          </Path>

          <Path title="Refine what you have" note={'The pieces already worn that gain the most '
            + 'from more refine, up to +9. Never +10: that last step is a gamble, not a plan.'}>
            {refines.map((move) => row(move, 'Apply', () => onApply([move]), build))}
          </Path>

          <Path title="Better-rolled copies" note={'The same piece with random options that suit '
            + 'this build, at a typical good roll. Farmed where you already get the piece.'}>
            {rolls.map((move) => row(move, 'Set rolls', () => onApply([move]), build, true, true))}
          </Path>

          <Path title="Longer-term goals" note={'Past what this build usually reaches — a longer '
            + 'grind, a tougher monster or a higher refine — but where it can head, one per slot, '
            + 'with what to farm for it.'}>
            {far.filter((m) => !farm.some((f) => f.label === m.label))
              .map((move) => row(move, 'Equip', () => onApply([move]), build, true))}
          </Path>

          {/* The search fills the lists in as it goes; this says there is
              more to come, so a short list is not read as the whole answer. */}
          {searching && (
            <div className="plan-searching" role="status">
              {nothing ? 'Looking…' : 'Still looking — more suggestions will appear here as they are found.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** One kind of way forward: a heading, a line on what it is, its rows. */
function Path({ title, note, children }: {
  title: string;
  note?: string;
  children: React.ReactNode[];
}) {
  if (children.length === 0) return null;
  return (
    <div className="path">
      <h4>{title}</h4>
      {note && <p className="empty-note">{note}</p>}
      <ol className="plan focus-list">
        {children.map((child, i) => <li key={i}>{child}</li>)}
      </ol>
    </div>
  );
}

/**
 * "Farm 1,000 Distortion Essence — Aspect of Lies, Morroc Town (4.65%)".
 *
 * Follows the hardest new piece in the suggestion down its cheapest route
 * to whatever actually has to be farmed. Nothing when that route ends at a
 * vendor or is not known.
 */
function FarmNote({ move, build, dataset, rolled }: {
  move: Move;
  build: Build;
  dataset: Dataset;
  /** A new copy of the worn piece is what is farmed, not anything new. */
  rolled?: boolean;
}) {
  let hardest: { id: number; effort: number } | null = null;
  for (const c of move.changes) {
    const was = build.slots[c.slot];
    const ids = [
      ...((rolled || c.state.itemId !== was?.itemId) && c.state.itemId ? [c.state.itemId] : []),
      ...c.state.cards.filter((id): id is number => !!id && !was?.cards.includes(id)),
    ];
    for (const id of ids) {
      const e = dataset.effort?.get(id)?.effort ?? 0;
      if (!hardest || e > hardest.effort) hardest = { id, effort: e };
    }
  }
  const target = hardest ? farmFor(hardest.id, dataset) : null;
  const item = target ? dataset.items.get(target.itemId) : null;
  if (!target || !item) return null;
  return (
    <>
      Farm {target.qty > 1 ? `${target.qty.toLocaleString()} ` : ''}{item.name}
      {' — '}{target.mob}, {target.zone} ({target.chance}%)
    </>
  );
}
