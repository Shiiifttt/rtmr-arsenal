import { useEffect, useMemo } from 'react';
import { applyChanges, farmFor, type Build, type Dataset, type Goal, type Move } from '@sim';
import { LockedNote, MoveRow } from './GoalsPanel';

/**
 * The plan from "Suggest changes" or "Find upgrades", over the build.
 *
 * Its own overlay rather than a list under the goals, for the same reason
 * as `GoalFocus`: each row is a full suggestion -- pieces, cards, refine,
 * every stat it moves -- and needs the picker's width, not a side panel's.
 *
 * Unlike the focus list, the rows are steps: each is measured from where
 * the ones above leave the build, and applying one applies everything
 * before it too.
 */
export function PlanOverlay({
  moves, stretch, rolls, upgrading, dataset, build, goals, lockedSlots, onApply, onClose,
}: {
  moves: Move[];
  /** Copies of worn pieces with rolls that suit the build better. */
  rolls: Move[];
  /** Out-of-reach alternatives, for when the plan has little to offer. */
  stretch: Move[];
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

  // The build each step starts from, which is how it will be applied.
  const stepBuilds = useMemo(() => {
    const out: Build[] = [];
    let at = build;
    for (const move of moves) {
      out.push(at);
      at = applyChanges(at, move.changes, dataset);
    }
    return out;
  }, [moves, build, dataset]);

  const title = upgrading ? 'Upgrades' : 'Suggested changes';

  return (
    <div className="overlay" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="picker focus" role="dialog" aria-modal="true" aria-label={title}>
        <div className="picker-head">
          <h3>{title}</h3>
          <span className="focus-sub">
            {upgrading ? 'raises a goal, lowers none' : 'towards the goals'}
          </span>
          <div className="spacer" />
          {moves.length > 1 && <button onClick={() => onApply(moves)}>Apply all</button>}
          <button onClick={onClose}>Close</button>
        </div>

        <div className="picker-list">
          {moves.length === 0 ? (
            <div className="loading">
              {upgrading
                ? 'Nothing within these options raises a goal without lowering another.'
                : 'Nothing within these options gets any closer.'}
              <div className="empty-note" style={{ marginTop: 6 }}>
                Loosening the class, level or refine options may help
                {lockedSlots > 0 && <LockedNote slots={lockedSlots} />}.
              </div>
            </div>
          ) : (
            <ol className="plan focus-list">
              {moves.map((move, i) => (
                <li key={i}>
                  <MoveRow
                    move={move}
                    goals={goals}
                    action={i === 0 ? 'Apply' : 'Apply up to here'}
                    onApply={() => onApply(moves.slice(0, i + 1))}
                    dataset={dataset}
                    build={stepBuilds[i]}
                  />
                </li>
              ))}
            </ol>
          )}

          {rolls.length > 0 && (
            <div className="stretch">
              <h4>Better-rolled copies</h4>
              <p className="empty-note">
                The same piece with random options that suit this build, at a
                typical good roll. Farmed where you already get the piece.
              </p>
              <ol className="plan focus-list">
                {rolls.map((move, i) => (
                  <li key={i}>
                    <MoveRow
                      move={move}
                      goals={goals}
                      action="Set rolls"
                      onApply={() => onApply([move])}
                      dataset={dataset}
                      build={build}
                      note={<FarmNote move={move} build={build} dataset={dataset} rolled />}
                    />
                  </li>
                ))}
              </ol>
            </div>
          )}

          {stretch.length > 0 && (
            <div className="stretch">
              <h4>Longer-term goals</h4>
              <p className="empty-note">
                Past what this build usually reaches — a longer grind, a tougher
                monster or a higher refine — but where the next real gains are.
                Alternatives, not steps.
              </p>
              <ol className="plan focus-list">
                {stretch.map((move, i) => (
                  <li key={i}>
                    <MoveRow
                      move={move}
                      goals={goals}
                      action="Equip"
                      onApply={() => onApply([move])}
                      dataset={dataset}
                      build={build}
                      note={<FarmNote move={move} build={build} dataset={dataset} />}
                    />
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>

        {moves.length > 1 && (
          <div className="picker-foot">
            <span>{moves.length} steps</span>
            <span>
              Steps build on each other, so they apply in order. This is a greedy
              plan — a good route, not a proof of the best build.
            </span>
          </div>
        )}
      </div>
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
