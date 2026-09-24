import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  aggregate, allGoals, applyChanges, carryInto, fitsCard, fitsSlot, rollTableFor,
  SLOTS, Suggester, swapHands, withLock,
  type Build, type Dataset, type Item, type Move, type SlotDef, type SlotState,
} from '@sim';
import { loadDataset } from './data';
import { emptyBuild, reconcile, STORAGE_KEY } from './build';
import { decodeBuild, payloadIn, shareUrl } from './share';
import { BuildsPanel } from './components/BuildsPanel';
import { SlotGrid } from './components/SlotGrid';
import { ItemPicker } from './components/ItemPicker';
import { BaseStatsPanel } from './components/BaseStatsPanel';
import { SetsPanel, StatsPanel, UncountedPanel } from './components/StatsPanel';
import { ImportPanel } from './components/ImportPanel';
import { RollImport } from './components/RollImport';
import { ItemTooltipLayer } from './components/ItemTooltip';
import { DEFAULT_PREFS, GoalsPanel, type SuggestPrefs } from './components/GoalsPanel';

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

/** A picker is either choosing the slot's item or a card for one socket. */
type Picking = { slot: SlotDef; socket: number | null };

export default function App() {
  const [dataset, setDataset] = useState<Dataset | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [build, setBuild] = useState<Build>(emptyBuild);
  const [picking, setPicking] = useState<Picking | null>(null);
  const [importing, setImporting] = useState(false);
  const [builds, setBuilds] = useState(false);
  /** Open the Builds panel with the share link already made. */
  const [wantLink, setWantLink] = useState(false);
  /** Brief acknowledgement on the toolbar's Share button. */
  const [copied, setCopied] = useState(false);
  /**
   * Showing a build that arrived in a link, and not yet adopted.
   *
   * Nothing is written to storage while this is on, so opening someone
   * else's link cannot cost you the build you were working on. It stays
   * exactly where it was until you say otherwise.
   */
  const [shared, setShared] = useState(false);
  /** The slot whose rolls are being read from a screenshot. */
  const [shooting, setShooting] = useState<SlotDef | null>(null);
  const [prefs, setPrefs] = useState<SuggestPrefs>(loadPrefs);

  useEffect(() => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* full or blocked */ }
  }, [prefs]);

  useEffect(() => {
    loadDataset().then(setDataset).catch((e) => setError(String(e)));
  }, []);

  // Restore a build once, after the data exists to validate it against: the
  // one in the link if the page was opened from one, otherwise the last one
  // worked on. A link wins because following a link is a thing you just did,
  // where the autosave is only where you left off.
  useEffect(() => {
    if (!dataset) return;
    let cancelled = false;
    void (async () => {
      if (await takeLink(dataset) || cancelled) return;
      restoreOwn(dataset);
    })();
    return () => { cancelled = true; };
  }, [dataset]);

  // A link pasted into the address bar of a tab that already has the app
  // open only changes the fragment -- the page never reloads, so the effect
  // above never runs again. Without this the link would appear to do
  // nothing, which is worse than it not working.
  useEffect(() => {
    if (!dataset) return;
    const onHash = () => { void takeLink(dataset); };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [dataset]);

  /** Show the build in the URL, if there is one. True if there was. */
  const takeLink = async (data: Dataset): Promise<boolean> => {
    const payload = payloadIn(location.href);
    if (!payload) return false;
    const incoming = await decodeBuild(payload);
    if (!incoming) return false;
    // Flagged before the build lands, so no render can ever see someone
    // else's build with the autosave still switched on.
    setShared(true);
    setBuild(reconcile(incoming, data));
    return true;
  };

  const restoreOwn = (data: Dataset) => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      setBuild(saved ? reconcile(JSON.parse(saved) as Build, data) : emptyBuild());
    } catch {
      // A corrupt or absent save is not worth failing over -- an empty
      // build is a usable answer and the broken one is left alone on disk.
      setBuild(emptyBuild());
    }
  };

  /**
   * Copy a link to this build, without opening anything.
   *
   * Sharing is the one thing in the Builds panel that is a single action
   * rather than a decision, so it gets a button of its own up here. If the
   * clipboard is not available -- an insecure origin, or the permission
   * refused -- the panel opens with the link already made, to copy by hand.
   */
  const copyLink = async (b: Build) => {
    const url = await shareUrl(b);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setWantLink(true);
      setBuilds(true);
    }
  };

  /** Stop treating this as someone else's build, and drop it from the URL. */
  const ownIt = () => {
    setShared(false);
    history.replaceState(null, '', location.href.split('#')[0]);
  };

  // The build this session started as, before anything was restored into it.
  const pristine = useRef(build);

  useEffect(() => {
    // Saving the empty build the app starts with would overwrite the one on
    // disk before the effect above has had a chance to put it back. Both run
    // in the same commit when the dataset arrives, and in development React
    // runs them twice, so the second pass would then read back the blank it
    // had just written.
    //
    // A shared build is not saved at all: a link is something you are
    // looking at, and it has no business replacing what you were building.
    if (!dataset || shared || build === pristine.current) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(build)); } catch { /* full or blocked */ }
  }, [build, dataset, shared]);

  const totals = useMemo(
    () => (dataset ? aggregate(build, dataset) : null),
    [build, dataset],
  );

  // One per goals-and-options, shared by the goals panel and the picker, so
  // the relevance filters are worked out once rather than on every open.
  // The goals as ranked, with the guard rails after them: a suggestion is
  // judged against both, so both go to the suggester as one list.
  const goals = build.goals;
  const guards = build.guards;
  const judged = useMemo(() => allGoals(build), [goals, guards]);
  const suggester = useMemo(() => (dataset ? new Suggester(dataset, judged, {
    className: prefs.mineOnly ? build.className : null,
    maxLevel: prefs.levelCap ? build.baseLevel : null,
    refine: prefs.refine,
  }) : null), [dataset, judged, prefs, build.className, build.baseLevel]);

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
        <button onClick={() => setBuilds(true)}>
          Builds
        </button>
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
        <button
          className={`share-btn ${copied ? 'shared' : ''}`}
          onClick={() => void copyLink(build)}
          title={'Copy a link to this build. It carries the whole thing — '
            + 'nothing is uploaded, and opening one never touches the '
            + 'reader\'s own build.'}
        >
          {copied ? 'Link copied' : 'Share'}
        </button>
      </header>

      {shared && (
        <div className="shared-banner">
          <strong>Shared build</strong>
          <span>
            Opened from a link. Nothing here is saved, and your own build is
            untouched — change what you like.
          </span>
          <div className="spacer" />
          <button
            onClick={ownIt}
            title={'Take this over as your own build. From here it saves as '
              + 'usual, replacing the one you had.'}
          >
            Make it mine
          </button>
          <button
            onClick={() => { restoreOwn(dataset); ownIt(); }}
            title="Go back to the build you were working on"
          >
            Back to mine
          </button>
        </div>
      )}

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
            onGuards={(next) => setBuild((b) => ({ ...b, guards: next }))}
            onPrefs={setPrefs}
            onApply={applyMoves}
          />
          <StatsPanel totals={totals} dataset={dataset} />
          <SetsPanel
            totals={totals}
            build={build}
            dataset={dataset}
            onFill={(changes) => setBuild((b) => applyChanges(b, changes, dataset))}
          />
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

      {builds && (
        <BuildsPanel
          dataset={dataset}
          build={build}
          autoShare={wantLink}
          onLoad={(next) => { setBuild(next); ownIt(); }}
          onClose={() => { setBuilds(false); setWantLink(false); }}
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
