import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  aggregate, applyChanges, brokenGoals, DEFAULT_GUARDS, diffTotals, goalLabel,
  goalMetrics, goalsFromBuild, goalStatus, guardsOf, isOffhandWeapon, SLOT_BY_KEY, SP_SUSTAIN,
  type Build, type Dataset, type Goal, type GoalMetric, type Item, type Move, type Suggester,
  type Totals, type TotalsChange,
} from '@sim';
import { GoalFocus } from './GoalFocus';
import { Icon } from './Icon';
import { tooltipProps } from './ItemTooltip';

/** The options that narrow what a suggestion may use. */
export interface SuggestPrefs {
  /** Only gear the chosen class can equip. */
  mineOnly: boolean;
  /** Only gear at or below the character's base level. */
  levelCap: boolean;
  /**
   * Refine assumed for a suggested piece: a fixed level, null to keep the
   * slot's, or 'auto' for as high as the goals reward.
   */
  refine: number | null | 'auto';
}

export const DEFAULT_PREFS: SuggestPrefs = { mineOnly: true, levelCap: true, refine: 'auto' };

interface Props {
  dataset: Dataset;
  build: Build;
  totals: Totals;
  suggester: Suggester;
  prefs: SuggestPrefs;
  onGoals: (goals: Goal[]) => void;
  /** The guard rails, as an explicit list. Empty means "none, deliberately". */
  onGuards: (guards: Goal[]) => void;
  onPrefs: (prefs: SuggestPrefs) => void;
  onApply: (moves: Move[]) => void;
}

/**
 * The numbers the player is building towards, and a plan to get there.
 *
 * Goals are also what the item picker ranks by, so this panel is where the
 * "Recommended" tab and the smart sort get their idea of better from.
 */
export function GoalsPanel({
  dataset, build, totals, suggester, prefs, onGoals, onGuards, onPrefs, onApply,
}: Props) {
  const goals = build.goals ?? [];
  const lockedSlots = build.locked?.length ?? 0;
  const metrics = useMemo(() => goalMetrics(dataset), [dataset]);
  const groups = useMemo(() => groupMetrics(metrics), [metrics]);
  const status = goalStatus(goals, totals, build, dataset);
  // The plan's own test, guards included: with everything met it hunts for
  // upgrades rather than stopping.
  const allMet = goalStatus(suggester.goals, totals, build, dataset).every((s) => s.met);

  // The plan belongs to the build it was worked out for. Once anything
  // changes -- a slot, a goal, an option -- it describes a different
  // starting point, so it is dropped rather than shown stale.
  const [plan, setPlan] = useState<{ for: Build; suggester: Suggester; moves: Move[] } | null>(null);
  const current = plan && plan.for === build && plan.suggester === suggester ? plan.moves : null;

  // "More of this one, please" for a single goal, on the same terms: dropped
  // as soon as it would describe a build that is no longer the one on screen.
  const [focus, setFocus] =
    useState<{ for: Build; suggester: Suggester; goal: Goal; moves: Move[] } | null>(null);
  const focused = focus && focus.for === build && focus.suggester === suggester ? focus : null;
  const stepBuilds = useMemo(() => {
    const out: Build[] = [];
    let at = build;
    for (const move of current ?? []) {
      out.push(at);
      at = applyChanges(at, move.changes, dataset);
    }
    return out;
  }, [current, build, dataset]);

  const labelOf = (g: Goal) =>
    metrics.find((m) => m.key === g.key && m.column === g.column)?.label ?? g.key;

  const update = (i: number, patch: Partial<Goal>) =>
    onGoals(goals.map((g, j) => (j === i ? { ...g, ...patch } : g)));

  /** Swap a goal with its neighbour: the order is the priority. */
  const move = (i: number, by: -1 | 1) => {
    const to = i + by;
    if (to < 0 || to >= goals.length) return;
    const next = [...goals];
    [next[i], next[to]] = [next[to], next[i]];
    onGoals(next);
  };

  const add = (value: string) => {
    const metric = metrics.find((m) => metricValue(m) === value);
    if (!metric) return;
    const goal: Goal = { key: metric.key, column: metric.column, target: 0 };
    // Starting from where the build already is means the new row reads as
    // "met" until a real target is typed, rather than as a failure.
    const now = goalStatus([goal], totals, build, dataset)[0].value;
    goal.target = Math.round(now);
    // Cooldowns, cast times, delays and SP costs are things to push down, so
    // a goal on one is a ceiling from the start.
    goal.atMost = goal.target < 0 || /cooldown|cast|delay|sp cost/i.test(metric.label);
    onGoals([...goals, goal]);
  };

  return (
    <div className="panel goals">
      <h2>Goals</h2>

      {goals.length === 0 && (
        <>
          <p className="empty-note" style={{ margin: '0 0 10px', fontSize: 12 }}>
            Add the numbers you are building towards. The item picker then ranks
            by them, and can recommend pieces, cards and set swaps to reach them.
          </p>
          <button
            className="goal-from-build"
            onClick={() => onGoals(goalsFromBuild(build, totals, dataset))}
            title={'Takes the stats your gear already stacks as the goals, at the '
              + 'values you have now.\n\nSuggest then looks for upgrades: changes '
              + 'that raise one of them without lowering any.'}
          >
            Use my current build
          </button>
        </>
      )}

      {status.map((s, i) => (
        <div
          className={`goal-row ${s.met ? 'met' : ''} ${focused?.goal === s.goal ? 'focused' : ''}`}
          key={i}
        >
          <button
            className="goal-name"
            title={`${labelOf(s.goal)}\n\nClick for the best ways to get more of it, `
              + 'whatever it costs the other goals'}
            onClick={() => setFocus({
              for: build, suggester, goal: s.goal, moves: suggester.focusMoves(build, s.goal),
            })}
          >{labelOf(s.goal)}</button>
          {/* The order is the priority, so it has to be editable in place.
              Stacked in one narrow column: the panel is 400px at its widest
              and the goal's name needs the room more than these do. */}
          <div className="goal-rank">
            <button
              onClick={() => move(i, -1)}
              disabled={i === 0}
              title="Higher priority"
              aria-label={`Raise the priority of ${labelOf(s.goal)}`}
            >▲</button>
            <button
              onClick={() => move(i, 1)}
              disabled={i === goals.length - 1}
              title="Lower priority"
              aria-label={`Lower the priority of ${labelOf(s.goal)}`}
            >▼</button>
          </div>
          <button
            className="goal-dir"
            onClick={() => update(i, { atMost: !s.goal.atMost })}
            title={s.goal.atMost ? 'At most — click for at least' : 'At least — click for at most'}
          >{s.goal.atMost ? '≤' : '≥'}</button>
          <input
            type="number"
            className="goal-target"
            value={s.goal.target}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) update(i, { target: n });
            }}
          />
          <span className="goal-now" title="Where the build is now">
            {fmt(s.value)}{s.goal.column === 'percent' ? '%' : ''}
          </span>
          <button
            className="x"
            onClick={() => onGoals(goals.filter((_, j) => j !== i))}
            aria-label={`Remove goal ${labelOf(s.goal)}`}
          >×</button>
          <div className="goal-bar" aria-hidden="true">
            <span style={{ width: `${Math.round(100 * (1 - Math.min(1, s.shortfall)))}%` }} />
          </div>
        </div>
      ))}

      <select
        className="goal-add"
        value=""
        onChange={(e) => add(e.target.value)}
        aria-label="Add a goal"
      >
        <option value="">+ Add a goal…</option>
        {groups.map(([category, list]) => (
          <optgroup key={category} label={category.replace(/_/g, ' ')}>
            {list.map((m) => (
              <option key={metricValue(m)} value={metricValue(m)}>{m.label}</option>
            ))}
          </optgroup>
        ))}
      </select>

      <Guards
        build={build}
        totals={totals}
        dataset={dataset}
        metrics={metrics}
        onGuards={onGuards}
      />

      {goals.length > 0 && (
        <>
          <div className="goal-opts">
            <label className="check">
              <input
                type="checkbox"
                checked={prefs.mineOnly && !!build.className}
                disabled={!build.className}
                onChange={(e) => onPrefs({ ...prefs, mineOnly: e.target.checked })}
              />
              {build.className ?? 'My class'} only
            </label>
            <label className="check" title="Only gear the character can wear at its base level">
              <input
                type="checkbox"
                checked={prefs.levelCap}
                onChange={(e) => onPrefs({ ...prefs, levelCap: e.target.checked })}
              />
              Up to Lv {build.baseLevel}
            </label>
            <label
              className="check"
              title={'The refine a suggested piece is assumed to have.\n'
                + 'Auto raises each piece only as far as it helps the goals, and '
                + 'names the refine it chose. Gear already worn keeps its refine.'}
            >
              Refine
              <select
                value={prefs.refine ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  onPrefs({ ...prefs, refine: v === 'auto' ? 'auto' : v === '' ? null : Number(v) });
                }}
              >
                <option value="auto">auto</option>
                <option value="">keep slot's</option>
                {Array.from({ length: 11 }, (_, n) => (
                  <option key={n} value={n}>+{n}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="goal-actions">
            <button
              onClick={() => setPlan({ for: build, suggester, moves: suggester.plan(build) })}
              title={allMet ? 'Every goal is met, so this looks for upgrades: changes '
                + 'that raise a goal without lowering any' : undefined}
            >
              {allMet ? 'Find upgrades' : 'Suggest changes'}
            </button>
            {current && current.length > 1 && (
              <button onClick={() => onApply(current)}>Apply all</button>
            )}
          </div>

          {current && current.length === 0 && (
            <p className="empty-note" style={{ fontSize: 12 }}>
              {allMet ? 'Nothing within these options raises a goal without lowering '
                + 'another' : 'Nothing within these options gets any closer'}. Loosening the class,
              level or refine options may help
              {lockedSlots > 0 && <LockedNote slots={lockedSlots} />}.
            </p>
          )}
          {current && current.length > 0 && (
            <ol className="plan">
              {current.map((move, i) => (
                <li key={i}>
                  <MoveRow
                    move={move}
                    goals={suggester.goals}
                    action={i === 0 ? 'Apply' : 'Apply up to here'}
                    onApply={() => onApply(current.slice(0, i + 1))}
                    dataset={dataset}
                    // Each step is measured from where the steps before it
                    // leave the build, which is how they will be applied.
                    build={stepBuilds[i]}
                  />
                </li>
              ))}
            </ol>
          )}
          {current && current.length > 1 && (
            <p className="empty-note" style={{ margin: '6px 0 0', fontSize: 11 }}>
              Steps build on each other, so they apply in order. This is a
              greedy plan — a good route, not a proof of the best build.
            </p>
          )}
        </>
      )}

      {/* Over the build rather than in this panel: the rows are full
          suggestions, and they need the room the picker gets. */}
      {focused && (
        <GoalFocus
          goal={focused.goal}
          label={labelOf(focused.goal)}
          moves={focused.moves}
          dataset={dataset}
          build={build}
          goals={suggester.goals}
          lockedSlots={lockedSlots}
          onApply={onApply}
          onClose={() => setFocus(null)}
        />
      )}
    </div>
  );
}

/**
 * The lines a suggestion may not cross.
 *
 * Separate from the goals above because they are a different kind of thing:
 * not a number to reach but a floor under the character, and not ranked
 * against anything. Without them the planner will happily trade away most
 * of a character's HP or SP for a few points of whatever is being chased,
 * because nothing in a score says those two are what keeps you playing.
 *
 * Shown rather than applied silently, and every part of them editable, so a
 * build that really is meant to run at 300 HP can say so.
 */
function Guards({ build, totals, dataset, metrics, onGuards }: {
  build: Build;
  totals: Totals;
  dataset: Dataset;
  metrics: GoalMetric[];
  onGuards: (guards: Goal[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const guards = guardsOf(build);
  const status = goalStatus(guards, totals, build, dataset);
  const breached = status.filter((s) => !s.met).length;
  const labelOf = (g: Goal) =>
    metrics.find((m) => m.key === g.key && m.column === g.column)?.label ?? g.key;

  return (
    <div className={`guards ${breached ? 'breached' : ''}`}>
      <button className="guards-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>Guard rails</span>
        <span className="guards-sum">
          {guards.length === 0 ? 'off'
            : breached ? `${breached} crossed`
            : `${guards.length} holding`}
        </span>
        <span className="guards-caret" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <>
          <p className="empty-note" style={{ margin: '2px 0 8px', fontSize: 11 }}>
            Floors a suggestion may not drop the build below. They are never
            chased — a guard that holds counts for nothing — so they cost the
            goals above nothing while they hold.
          </p>
          {status.map((s, i) => (
            <div className={`goal-row guard ${s.met ? 'met' : ''}`} key={i}>
              <span className="goal-name" title={guardHint(s.goal.key)}>
                {labelOf(s.goal)}
              </span>
              <span className="goal-dir" title="At least">≥</span>
              <input
                type="number"
                className="goal-target"
                value={s.goal.target}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  if (Number.isFinite(n)) {
                    onGuards(guards.map((g, j) => (j === i ? { ...g, target: n } : g)));
                  }
                }}
              />
              <span className="goal-now" title="Where the build is now">
                {fmt(s.value)}%
              </span>
              <button
                className="x"
                onClick={() => onGuards(guards.filter((_, j) => j !== i))}
                aria-label={`Remove guard ${labelOf(s.goal)}`}
              >×</button>
            </div>
          ))}
          {guards.length < DEFAULT_GUARDS.length && (
            <button className="more" onClick={() => onGuards(DEFAULT_GUARDS)}>
              Restore the default guard rails
            </button>
          )}
        </>
      )}
    </div>
  );
}

/** Why this particular number is one worth putting a floor under. */
function guardHint(key: string): string {
  return key === SP_SUSTAIN
    ? 'Casts you can afford, against having no gear bonus at all: Max SP % '
      + 'weighed against SP Cost %.\n\nSo -60% Max SP is fine alongside -60% '
      + 'SP cost — the two cancel — and it is only the ratio that is guarded.'
    : 'Max HP from gear, as a percentage. Shadow gear in particular buys its '
      + 'bonuses with HP, and enough of it stacked leaves a character that '
      + 'cannot take a hit.';
}

/**
 * One suggested change: what it puts on, and everything that does to the
 * build -- not only to the goals. A swap that gains 10 crit and quietly
 * drops 2,000 HP should say both.
 *
 * Each piece is hoverable for its full tooltip, at the refine and with the
 * cards the suggestion gives it, so what is being recommended can be read
 * the same way as anything in the slot grid.
 */
export function MoveRow({ move, goals, action, onApply, dataset, build }: {
  move: Move;
  goals: Goal[];
  action: string;
  onApply: () => void;
  dataset: Dataset;
  /** The build the move applies to, so its full effect can be worked out. */
  build: Build;
}) {
  const changes = useMemo(() => diffTotals(
    aggregate(build, dataset),
    aggregate(applyChanges(build, move.changes, dataset), dataset),
    dataset,
  ), [build, move, dataset]);
  const isGoal = (c: TotalsChange) => goals.some((g) => g.key === c.key && g.column === c.column);
  // Goals this move would take below their target. Said first, because it is
  // the one consequence a player would not forgive being buried.
  const broken = brokenGoals(goals, move.before, move.after);
  const pieces = move.changes.map((c) => {
    const item = dataset.items.get(c.state.itemId ?? -1);
    const cards = c.state.cards.map((id) => (id ? dataset.items.get(id) ?? null : null));
    const def = SLOT_BY_KEY.get(c.slot);
    const was = build.slots[c.slot];
    return { slot: def?.label ?? c.slot, item, state: c.state, cards,
      offhand: !!def && isOffhandWeapon(def, item),
      // A move that keeps the piece and changes its cards is a move about
      // the cards, so those are what it should show.
      newPiece: !!item && item.id !== was?.itemId };
  });
  const first = pieces.find((p) => p.item);

  /**
   * What the row is putting on, as icons: the pieces it swaps in, or the
   * cards where the piece itself is staying. Without them a recommendation
   * is a wall of names, while the picker it is offered next to is all icons.
   */
  const icons = useMemo(() => {
    const out: { item: Item; target: Parameters<typeof tooltipProps>[0] }[] = [];
    for (const p of pieces) {
      const props = { kind: 'item' as const, item: p.item!, refine: p.state.refine,
        cards: p.cards, offhand: p.offhand };
      if (p.newPiece) {
        out.push({ item: p.item!, target: props });
        continue;
      }
      // Distinct cards only: four of the same card is one icon, not four.
      const seen = new Set<number>();
      for (const card of p.cards) {
        if (!card || seen.has(card.id)) continue;
        seen.add(card.id);
        out.push({ item: card, target: { kind: 'item', item: card, hostRefine: p.state.refine } });
      }
      if (seen.size === 0 && p.item) out.push({ item: p.item, target: props });
    }
    return out.slice(0, 4);
  }, [pieces]);

  return (
    <div className={`move ${move.sidegrade ? 'side' : ''} ${move.maxed ? 'maxed' : ''}`}>
      {icons.length > 0 && (
        <div className="move-icons">
          {icons.map(({ item, target }, i) => (
            <span key={i} {...tooltipProps(target)}><Icon item={item} /></span>
          ))}
        </div>
      )}
      <div className="move-main">
        <div
          className="move-label"
          {...(first?.item ? tooltipProps({
            kind: 'item', item: first.item, refine: first.state.refine, cards: first.cards,
            offhand: first.offhand,
          }) : {})}
        >{move.label}</div>
        <div className="move-slots">
          {broken.length > 0 && (
            <span
              className="below"
              title={'This would leave a goal you have met short of its target.\n\n'
                + 'Listed after everything that keeps them all met, and never planned.'}
            >
              Below {broken.map((g) => goalLabel(g, dataset)).join(', ')} ·{' '}
            </span>
          )}
          {move.maxed && (
            <span title="The suggestion above, with the pieces it puts on at full refine">
              At full refine ·{' '}
            </span>
          )}
          {move.sidegrade && (
            <span title="Helps some goals but costs others — a trade, not an upgrade">
              Sidegrade ·{' '}
            </span>
          )}
          {move.kind === 'set' ? 'Set · ' : move.kind === 'cards' ? 'Cards · '
            : move.kind === 'sockets' ? 'More slots · '
            : move.kind === 'rolls' ? 'Random options · ' : ''}
          {pieces.map((p, i) => (
            <span key={i}>
              {i > 0 && ', '}
              {p.item ? (
                <span
                  className="move-piece"
                  {...tooltipProps({ kind: 'item', item: p.item, refine: p.state.refine, cards: p.cards, offhand: p.offhand })}
                >
                  {p.slot}: {p.state.refine > 0 ? `+${p.state.refine} ` : ''}{p.item.name}
                </span>
              ) : `${p.slot}: empty`}
            </span>
          ))}
        </div>
        {/* The goals inline, since they are why the row is here; the rest
            behind a hover, where a long list can be read in two columns
            without burying the next suggestion. */}
        <div className="deltas">
          {changes.filter(isGoal).map((c, i) => <Change key={i} c={c} />)}
          <EffectsButton changes={changes} />
        </div>
      </div>
      <button onClick={onApply}>{action === 'Equip' && move.kind === 'rolls' ? 'Set rolls' : action}</button>
    </div>
  );
}

function Change({ c }: { c: TotalsChange }) {
  return (
    <span className={`delta ${c.tone === 'bad' ? 'down' : 'up'}`}>
      {c.delta > 0 ? '+' : ''}{fmt(c.delta)}{c.unit} {c.label}
    </span>
  );
}

/**
 * "12 gains · 3 losses", opening a two-column list of everything a change
 * does. Rendered into the body at a fixed position so the picker's
 * scrolling list cannot clip it.
 */
function EffectsButton({ changes }: { changes: TotalsChange[] }) {
  const [at, setAt] = useState<{ left: number; top: number; up: boolean } | null>(null);
  const gains = changes.filter((c) => c.tone !== 'bad');
  const losses = changes.filter((c) => c.tone === 'bad');
  if (changes.length === 0) return <span className="fx-none">no change to any stat</span>;

  const open = (el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    // Opens downward unless that would run off the bottom of the window.
    const up = r.bottom + 260 > window.innerHeight;
    setAt({ left: Math.min(r.left, window.innerWidth - 480), top: up ? r.top - 6 : r.bottom + 6, up });
  };
  return (
    <>
      <button
        className="fx-btn"
        onMouseEnter={(e) => open(e.currentTarget)}
        onMouseLeave={() => setAt(null)}
        onFocus={(e) => open(e.currentTarget)}
        onBlur={() => setAt(null)}
      >
        <span className="up">{gains.length} gain{gains.length === 1 ? '' : 's'}</span>
        {' · '}
        <span className={losses.length ? 'down' : ''}>
          {losses.length} loss{losses.length === 1 ? '' : 'es'}
        </span>
      </button>
      {at && createPortal(
        <div
          className="tip fx-pop"
          style={{ left: at.left, top: at.top, transform: at.up ? 'translateY(-100%)' : undefined }}
        >
          <div className="fx-col">
            <div className="tip-sec-title">You gain</div>
            {gains.length ? gains.map((c, i) => <div key={i}><Change c={c} /></div>)
              : <div className="tip-dim">nothing</div>}
          </div>
          <div className="fx-col">
            <div className="tip-sec-title">You lose</div>
            {losses.length ? losses.map((c, i) => <div key={i}><Change c={c} /></div>)
              : <div className="tip-dim">nothing</div>}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/** Each goal the change moves, and by how much, coloured by direction. */
export function Deltas({ goals, before, after, labelOf }: {
  goals: Goal[];
  before: number[];
  after: number[];
  labelOf: (g: Goal) => string;
}) {
  const broken = new Set(brokenGoals(goals, before, after));
  const chips = goals.map((goal, i) => {
    const d = after[i] - before[i];
    if (Math.abs(d) < 1e-9) return null;
    // A guard is a floor, not a number being chased, so a chip for it on
    // every row in the picker is noise -- it moves whatever you are
    // looking at. The exception is a change that actually crosses it,
    // which is the one thing the guard exists to say.
    if (goal.guard && !broken.has(goal)) return null;
    const better = goal.atMost ? d < 0 : d > 0;
    return (
      <span
        key={i}
        className={`delta ${better ? 'up' : 'down'}${broken.has(goal) ? ' below' : ''}`}
        title={broken.has(goal) ? 'This drops below the target you set' : undefined}
      >
        {d > 0 ? '+' : ''}{fmt(d)}{goal.column === 'percent' ? '%' : ''}{' '}
        {/* The number already carries the %, so the label need not repeat it. */}
        {labelOf(goal).replace(/ %$/, '')}
      </span>
    );
  }).filter(Boolean);
  if (chips.length === 0) return null;
  return <div className="deltas">{chips}</div>;
}

function metricValue(m: GoalMetric) {
  return `${m.key}:${m.column}`;
}

function groupMetrics(metrics: GoalMetric[]): [string, GoalMetric[]][] {
  const by = new Map<string, GoalMetric[]>();
  for (const m of metrics) {
    const list = by.get(m.category) ?? [];
    list.push(m);
    by.set(m.category, list);
  }
  return [...by];
}

function fmt(n: number) {
  return `${Math.round(n * 100) / 100}`;
}

/**
 * ", or unlocking one of the 3 locked slots" -- said only where a suggestion
 * came back empty, because a lock is the one reason for that which the
 * options above the note do not explain.
 */
export function LockedNote({ slots }: { slots: number }) {
  return <>, or unlocking {slots === 1 ? 'the locked slot' : `one of the ${slots} locked slots`}</>;
}
