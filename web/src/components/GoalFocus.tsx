import { useEffect } from 'react';
import { brokenGoals } from '@sim';
import type { Build, Dataset, Goal, Move } from '@sim';
import { LockedNote, MoveRow } from './GoalsPanel';

/**
 * "Just give me more of this one number."
 *
 * The plan answers how to reach a target; this answers the other question,
 * which is what else could push one stat further -- the only question left
 * once a goal is met. It opens over the build rather than inside the Goals
 * panel because the rows are full suggestions, the same width and shape as
 * the picker's: a piece, its cards, its refine, every stat it moves, and a
 * button that equips it.
 *
 * Each row is an alternative to the build as it stands, not a step, so they
 * do not build on each other and every one is measured from the same place.
 */
export function GoalFocus({
  goal, label, moves, dataset, build, goals, lockedSlots, onApply, onClose,
}: {
  goal: Goal;
  /** The goal's name as the panel writes it, e.g. "Melee Damage %". */
  label: string;
  moves: Move[];
  dataset: Dataset;
  build: Build;
  goals: Goal[];
  /** How many slots are locked, for the note when nothing can be suggested. */
  lockedSlots: number;
  onApply: (moves: Move[]) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const below = moves.filter((m) => brokenGoals(goals, m.before, m.after).length > 0);
  const free = moves.filter((m) => !m.sidegrade && !below.includes(m)).length;
  const trades = moves.length - free - below.length;
  const title = `More ${label}`;

  return (
    <div className="overlay" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="picker focus" role="dialog" aria-modal="true" aria-label={title}>
        <div className="picker-head">
          <h3>{title}</h3>
          <span className="focus-sub">
            {goal.atMost ? 'at most' : 'at least'} {goal.target}
            {goal.column === 'percent' ? '%' : ''}
          </span>
          <div className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>

        <div className="picker-list">
          {moves.length === 0 ? (
            <div className="loading">
              Nothing within these options gives more {label}.
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
                    action="Equip"
                    onApply={() => onApply([move])}
                    dataset={dataset}
                    build={build}
                  />
                </li>
              ))}
            </ol>
          )}
        </div>

        <div className="picker-foot">
          <span>
            {free} free{trades > 0 && `, ${trades} trade${trades === 1 ? '' : 's'}`}
            {below.length > 0 && `, ${below.length} below a target`}
          </span>
          <span>
            Most {label} first among the swaps that cost no other goal anything, then
            the trades, best value for what they cost first. Anything that would leave
            another goal short of its target is last, whatever it buys.
          </span>
        </div>
      </div>
    </div>
  );
}
