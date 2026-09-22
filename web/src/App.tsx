import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  aggregate, applyChanges, BASE_LEVEL_DEFAULT, carryInto, clampBaseLevel,
  clampBaseStat, defaultBaseStats, fitsCard, fitsSlot, goalMetrics, rollTableFor,
  SLOT_BY_KEY, SLOTS, Suggester, swapHands, withLock,
  type BaseStats, type Build, type Dataset, type Goal, type Item, type Move,
  type SlotDef, type SlotState,
} from '@sim';
import { loadDataset } from './data';
import { SlotGrid } from './components/SlotGrid';
import { ItemPicker } from './components/ItemPicker';
import { BaseStatsPanel } from './components/BaseStatsPanel';
import { SetsPanel, StatsPanel, UncountedPanel } from './components/StatsPanel';
import { ImportPanel } from './components/ImportPanel';
import { RollImport } from './components/RollImport';
import { ItemTooltipLayer } from './components/ItemTooltip';
import { DEFAULT_PREFS, GoalsPanel, type SuggestPrefs } from './components/GoalsPanel';

// Bumped when the saved shape changes, so an older save is discarded rather
// than half-restored into a build that no longer has the same fields.
// Rolls were added as an optional field, so a v3 save still reconciles
// cleanly and there is no reason to throw one away.
const STORAGE_KEY = 'rtmr.build.v3';
// Kept apart from the build: these are how the player likes suggestions
// narrowed, not part of any one character.
// v2: refine gained 'auto', which is now the default. A v1 save only ever
// held the old default, so it is left behind rather than carried over.
const PREFS_KEY = 'rtmr.suggest.v2';

function loadPrefs(): SuggestPrefs {
  try {
    const saved = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null');
    if (saved && typeof saved === 'object') {
      return {
        mineOnly: saved.mineOnly !== false,
        levelCap: saved.levelCap !== false,
        refine: saved.refine === 'auto' || saved.refine === undefined ? 'auto'
          : Number.isInteger(saved.refine) ? saved.refine : null,
      };
    }
  } catch { /* absent or blocked storage is not worth failing over */ }
  return DEFAULT_PREFS;
}

function emptyBuild(): Build {
  const slots: Record<string, SlotState> = {};
  for (const slot of SLOTS) slots[slot.key] = { itemId: null, refine: 0, cards: [] };
  return {
    className: null,
    baseLevel: BASE_LEVEL_DEFAULT,
    baseStats: defaultBaseStats(),
    slots,
  };
}

/** A picker is either choosing the slot's item or a card for one socket. */
type Picking = { slot: SlotDef; socket: number | null };

export default function App() {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [build, setBuild] = useState<Build>(emptyBuild);
  const [picking, setPicking] = useState<Picking | null>(null);
  const [importing, setImporting] = useState(false);
  /** The slot whose rolls are being read from a screenshot. */
  const [shooting, setShooting] = useState<SlotDef | null>(null);
  const [prefs, setPrefs] = useState<SuggestPrefs>(loadPrefs);

  useEffect(() => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* full or blocked */ }
  }, [prefs]);

  useEffect(() => {
    loadDataset().then(setDataset).catch((e) => setError(String(e)));
  }, []);

  // Restore the last build once, after the data exists to validate it against.
  useEffect(() => {
    if (!dataset) return;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) setBuild(reconcile(JSON.parse(saved) as Build, dataset));
    } catch { /* a corrupt or absent save is not worth failing over */ }
  }, [dataset]);

  // The build this session started as, before anything was restored into it.
  const pristine = useRef(build);

  useEffect(() => {
    // Saving the empty build the app starts with would overwrite the one on
    // disk before the effect above has had a chance to put it back. Both run
    // in the same commit when the dataset arrives, and in development React
    // runs them twice, so the second pass would then read back the blank it
    // had just written.
    if (!dataset || build === pristine.current) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(build)); } catch { /* full or blocked */ }
  }, [build, dataset]);

  const totals = useMemo(
    () => (dataset ? aggregate(build, dataset) : null),
    [build, dataset],
  );

  // One per goals-and-options, shared by the goals panel and the picker, so
  // the relevance filters are worked out once rather than on every open.
  const goals = build.goals;
  const suggester = useMemo(() => (dataset ? new Suggester(dataset, goals ?? [], {
    className: prefs.mineOnly ? build.className : null,
    maxLevel: prefs.levelCap ? build.baseLevel : null,
    refine: prefs.refine,
  }) : null), [dataset, goals, prefs, build.className, build.baseLevel]);

  const setSlot = useCallback((key: string, patch: Partial<SlotState>) => {
    setBuild((b) => ({ ...b, slots: { ...b.slots, [key]: { ...b.slots[key], ...patch } } }));
  }, []);

  const candidates = useMemo(() => {
    if (!dataset || !picking) return [];
    const { slot, socket } = picking;
    // The off hand takes either a shield or a weapon, and which cards fit
    // depends on which of those is actually in it.
    const equipped = dataset.items.get(build.slots[slot.key]?.itemId ?? -1) ?? null;
    return socket === null
      ? dataset.itemList.filter((i) => fitsSlot(i, slot))
      : dataset.itemList.filter((i) => fitsCard(i, slot, equipped));
  }, [dataset, picking, build.slots]);

  if (error) {
    return (
      <div className="loading error">
        Could not load the dataset.<br />{error}
        <p className="empty-note">Run the crawler first, then start the dev server.</p>
      </div>
    );
  }
  if (!dataset || !totals || !suggester) {
    return <div className="loading">Loading dataset…</div>;
  }

  const applyMoves = (moves: Move[]) => setBuild((b) =>
    moves.reduce((acc, m) => applyChanges(acc, m.changes, dataset), b));

  const onPick = (item: Item) => {
    if (!picking) return;
    const { slot, socket } = picking;
    if (socket === null) {
      // Swapping the item keeps the refine, cards and rolls already set --
      // trying a different piece while planning is a comparison, not a
      // fresh start. Anything the new item cannot take is dropped by
      // carryInto; clearing the slot is how you start over.
      setSlot(slot.key, carryInto(build.slots[slot.key], item, slot, dataset));
    } else {
      const cards = [...build.slots[slot.key].cards];
      cards[socket] = item.id;
      setSlot(slot.key, { cards });
    }
    setPicking(null);
  };

  const equippedCount = SLOTS.filter((s) => build.slots[s.key]?.itemId).length;

  // The piece whose rolls are being read, and the table it rolls under.
  const shotItem = shooting
    ? dataset.items.get(build.slots[shooting.key]?.itemId ?? -1) ?? null
    : null;
  const shotTable = shooting
    ? rollTableFor(dataset.rolls, shooting.key, shotItem)
    : null;

  return (
    <div className="app">
      <header className="topbar">
        <h1>RTM <span>Arsenal</span></h1>
        <select
          style={{ width: 220 }}
          value={build.className ?? ''}
          onChange={(e) => setBuild((b) => ({ ...b, className: e.target.value || null }))}
        >
          <option value="">Any class</option>
          {dataset.classes.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <span className="empty-note" style={{ fontSize: 12 }}>
          {equippedCount} equipped
        </span>
        <div className="spacer" />
        <button onClick={() => setImporting(true)}>
          Read a screenshot
        </button>
        <button
          title="Empties every slot. The class, stat points, goals and locks stay."
          onClick={() => setBuild((b) => ({
            ...emptyBuild(), className: b.className,
            baseLevel: b.baseLevel, baseStats: b.baseStats, goals: b.goals,
            // A lock is a planning preference like a goal, not gear.
            locked: b.locked,
          }))}
        >
          Clear gear
        </button>
      </header>

      <div className="columns">
        <div>
          <SlotGrid
            dataset={dataset}
            build={build}
            onOpenItem={(slot) => setPicking({ slot, socket: null })}
            onOpenCard={(slot, socket) => setPicking({ slot, socket })}
            onClear={(key) => setSlot(key, {
              itemId: null, refine: 0, cards: [], rolls: {},
            })}
            onClearCard={(key, socket) => {
              const cards = [...build.slots[key].cards];
              cards[socket] = null;
              setSlot(key, { cards });
            }}
            onAddCard={(key, socket, cardId) => {
              const cards = [...build.slots[key].cards];
              cards[socket] = cardId;
              setSlot(key, { cards });
            }}
            onRefine={(key, refine) => setSlot(key, { refine })}
            onRoll={(key, rollKey, pick) => {
              const rolls = { ...(build.slots[key].rolls ?? {}) };
              if (pick) rolls[rollKey] = pick;
              else delete rolls[rollKey];
              setSlot(key, { rolls });
            }}
            onImportRolls={setShooting}
            onSwapHands={() => setBuild((b) => swapHands(b, dataset) ?? b)}
            onToggleLock={(key, locked) => setBuild((b) => withLock(b, key, locked))}
          />
        </div>

        <div>
          <BaseStatsPanel
            baseStats={build.baseStats}
            baseLevel={build.baseLevel}
            totals={totals}
            dataset={dataset}
            onChange={(key, value) => setBuild((b) => ({
              ...b, baseStats: { ...b.baseStats, [key]: value },
            }))}
            onLevelChange={(value) => setBuild((b) => ({ ...b, baseLevel: value }))}
            onManualChange={(key, value) => setBuild((b) => ({
              ...b, manual: { ...(b.manual ?? {}), [key]: value },
            }))}
          />
          <GoalsPanel
            dataset={dataset}
            build={build}
            totals={totals}
            suggester={suggester}
            prefs={prefs}
            onGoals={(next) => setBuild((b) => ({ ...b, goals: next }))}
            onPrefs={setPrefs}
            onApply={applyMoves}
          />
          <StatsPanel totals={totals} dataset={dataset} />
          <SetsPanel totals={totals} />
          <UncountedPanel totals={totals} />
        </div>
      </div>

      {shotItem && shotTable && shooting && (
        <RollImport
          slot={shooting}
          item={shotItem}
          table={shotTable}
          onApply={(picks) => setSlot(shooting.key, {
            rolls: { ...(build.slots[shooting.key].rolls ?? {}), ...picks },
          })}
          onClose={() => setShooting(null)}
        />
      )}

      {importing && (
        <ImportPanel
          dataset={dataset}
          build={build}
          onApply={setBuild}
          onClose={() => setImporting(false)}
        />
      )}

      {picking && (
        <ItemPicker
          dataset={dataset}
          candidates={candidates}
          slot={picking.slot}
          socket={picking.socket}
          build={build}
          suggester={suggester}
          onApplyMove={(move) => applyMoves([move])}
          className={build.className}
          title={picking.socket === null
            ? `Choose ${picking.slot.label}`
            : `Choose a card for ${picking.slot.label}`}
          onPick={onPick}
          onClose={() => setPicking(null)}
        />
      )}

      <ItemTooltipLayer dataset={dataset} totals={totals} />
    </div>
  );
}

/**
 * Drop anything in a saved build that the current dataset no longer has.
 *
 * Builds outlive crawls, and an item that has been renamed or removed would
 * otherwise sit in a slot as a blank that cannot be cleared.
 */
function reconcile(saved: Build, dataset: Dataset): Build {
  const fresh = emptyBuild();
  fresh.className = saved.className && dataset.classes.includes(saved.className)
    ? saved.className : null;
  if (typeof saved.baseLevel === 'number') {
    fresh.baseLevel = clampBaseLevel(saved.baseLevel);
  }
  // Only finite numbers, so a corrupt save cannot put NaN into a total.
  if (saved.manual) {
    fresh.manual = Object.fromEntries(
      Object.entries(saved.manual).filter(([, v]) => Number.isFinite(v)));
  }

  // Locks are slot keys, so only ones this version still has a slot for.
  if (Array.isArray(saved.locked)) {
    fresh.locked = saved.locked.filter((key) => SLOT_BY_KEY.has(key));
  }

  // Only goals on a number this dataset still has, with a usable target.
  if (Array.isArray(saved.goals)) {
    const metrics = goalMetrics(dataset);
    fresh.goals = saved.goals.filter((g: Goal) => Number.isFinite(g?.target)
      && metrics.some((m) => m.key === g.key && m.column === g.column));
  }

  for (const key of Object.keys(fresh.baseStats) as (keyof BaseStats)[]) {
    const value = saved.baseStats?.[key];
    if (typeof value === 'number') fresh.baseStats[key] = clampBaseStat(value);
  }

  for (const slot of SLOTS) {
    const state = saved.slots?.[slot.key];
    if (!state?.itemId) continue;
    const item = dataset.items.get(state.itemId);
    if (!item || !fitsSlot(item, slot)) continue;

    // The same narrowing a swap does: a refine over the current cap, a card
    // that no longer fits, a roll whose option has gone.
    fresh.slots[slot.key] = carryInto(state, item, slot, dataset);
  }
  return fresh;
}
