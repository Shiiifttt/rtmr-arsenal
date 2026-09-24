import { useEffect, useMemo } from 'react';
import { applyChanges, type Build, type Dataset, type Goal, type Move } from '@sim';
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
  moves, upgrading, dataset, build, goals, lockedSlots, onApply, onClose,
}: {
  moves: Move[];
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
