import { useEffect, useMemo, useRef, useState } from 'react';
import {
  canEquip, goalLabel, isLocked,
  type Build, type Dataset, type Goal, type Item, type Move, type SlotDef, type Suggester,
} from '@sim';
import { Deltas, MoveRow } from './GoalsPanel';
import { Icon } from './Icon';
import { tooltipProps } from './ItemTooltip';

interface Props {
  dataset: Dataset;
  /** Candidate pool, already narrowed to what fits the slot. */
  candidates: Item[];
  title: string;
  className: string | null;
  onPick: (item: Item) => void;
  onClose: () => void;
  slot: SlotDef;
  /** The socket being filled, or null when choosing the slot's item. */
  socket: number | null;
  build: Build;
  /** Scores against the player's goals; inactive when there are none. */
  suggester: Suggester;
  /** Take a recommendation, which may touch more than this one slot. */
  onApplyMove: (move: Move) => void;
}

type Sort = 'goals' | 'name' | 'level';

/**
 * The item chooser.
 *
 * Filtering runs over the whole list on every keystroke. That is fine here:
 * the pool is a few thousand objects already in memory, so a plain filter
 * beats the complexity of an index, and results stay in step with the
 * search box with no debounce.
 */
export function ItemPicker({
  dataset, candidates, title, className, onPick, onClose,
  slot, socket, build, suggester, onApplyMove,
}: Props) {
  const smart = suggester.active;
  // A locked slot is settled: the planner has nothing to say about it. Its
  // items are still listed and still sortable, because opening the picker on
  // a slot is the player choosing, not the planner proposing.
  const locked = isLocked(build, slot.key);
  const [tab, setTab] = useState<'all' | 'recommended'>('all');
  const [sort, setSort] = useState<Sort>(smart ? 'goals' : 'name');
  const [query, setQuery] = useState('');
  const [type, setType] = useState('');
  const [onlyUsable, setOnlyUsable] = useState(true);
  const [minSlots, setMinSlots] = useState('');
  // Level bounds as typed text, not numbers: a half-typed "1" while reaching
  // for "130" would otherwise filter the list down to nothing mid-keystroke.
  const [minLevel, setMinLevel] = useState('');
  const [maxLevel, setMaxLevel] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => { searchRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const types = useMemo(() => {
    const set = new Set<string>();
    for (const item of candidates) if (item.type) set.add(item.type);
    return [...set].sort();
  }, [candidates]);

  // Scored once per opening, not per keystroke: the filters below only
  // narrow the pool, so the scores for what is left do not change.
  const goals = suggester.goals;
  const before = useMemo(() => (smart ? suggester.values(build) : []), [smart, suggester, build]);
  const scores = useMemo(
    () => (smart ? suggester.rank(build, slot.key, socket, candidates) : new Map()),
    [smart, suggester, build, slot.key, socket, candidates],
  );
  const labelOf = (g: Goal) => goalLabel(g, dataset);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const min = minSlots ? Number(minSlots) : 0;
    const lo = minLevel.trim() === '' ? null : Number(minLevel);
    const hi = maxLevel.trim() === '' ? null : Number(maxLevel);
    const out = candidates.filter((item) => {
      if (type && item.type !== type) return false;
      if (min && item.card_slots < min) return false;
      // An item with no requirement is level 0 and passes any lower bound,
      // which is right: it is wearable at every level, not at none.
      if (lo !== null && Number.isFinite(lo) && item.required_level < lo) return false;
      if (hi !== null && Number.isFinite(hi) && item.required_level > hi) return false;
      if (onlyUsable && !canEquip(item, className, dataset.classRules)) return false;
      if (!q) return true;
      // Search the effect text too, so "per refine" or "Double Attack"
      // finds the gear that does it, not just gear named after it.
      return item.name.toLowerCase().includes(q)
        || item.description.toLowerCase().includes(q);
    });
    const byName = (a: Item, b: Item) => a.name.localeCompare(b.name);
    if (sort === 'goals' && smart) {
      // Best for the goals first; everything that does nothing for them
      // keeps its alphabetical order after, and anything that sets them
      // back sinks to the bottom rather than disappearing.
      const gain = (i: Item) => scores.get(i.id)?.gain ?? 0;
      out.sort((a, b) => gain(b) - gain(a) || byName(a, b));
    } else if (sort === 'level') {
      out.sort((a, b) => b.required_level - a.required_level || byName(a, b));
    } else {
      out.sort(byName);
    }
    return out;
  }, [candidates, query, type, minSlots, minLevel, maxLevel, onlyUsable, className,
    dataset.classRules, sort, smart, scores]);

  const shown = results.slice(0, 300);

  const recommended = useMemo<Move[]>(() => {
    if (!smart || locked || tab !== 'recommended') return [];
    if (socket === null) return suggester.slotMoves(build, slot.key, 15);
    // For one socket, a recommendation is simply the best card for it.
    return candidates
      .map((card) => ({ card, s: scores.get(card.id) }))
      .filter(({ card, s }) => s && s.gain > 1e-9
        && (!onlyUsable || canEquip(card, className, dataset.classRules)))
      .sort((a, b) => b.s!.gain - a.s!.gain)
      .slice(0, 15)
      .map(({ card, s }) => {
        const cards = [...(build.slots[slot.key]?.cards ?? [])];
        cards[socket] = card.id;
        return {
          kind: 'cards' as const,
          label: card.name,
          changes: [{ slot: slot.key, state: { ...build.slots[slot.key], cards } }],
          gain: s!.gain, before, after: s!.after,
        };
      });
  }, [smart, locked, tab, socket, suggester, build, slot.key, candidates, scores, before,
    onlyUsable, className, dataset.classRules]);

  // Pieces with more sockets than the one worn. Offered with or without
  // goals, so the Recommended tab is open whenever there is one to show.
  const moreSockets = useMemo<Move[]>(
    () => (socket === null ? suggester.socketMoves(build, slot.key) : []),
    [socket, suggester, build, slot.key],
  );
  // What to aim for when the piece already worn is rerolled or dropped again.
  const rollAdvice = useMemo<Move[]>(
    () => (socket === null ? suggester.rollMoves(build, slot.key) : []),
    [socket, suggester, build, slot.key],
  );
  const hasRecs = (smart || moreSockets.length > 0) && !locked;
  const showRecs = tab === 'recommended' && hasRecs;
  const recRow = (move: Move, i: number) => (
    <div className="picker-row rec" key={i}>
      <MoveRow
        move={move}
        goals={goals}
        action={move.changes.length > 1 ? 'Equip all' : 'Equip'}
        onApply={() => { onApplyMove(move); onClose(); }}
        dataset={dataset}
        build={build}
      />
    </div>
  );

  return (
    <div className="overlay" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="picker" role="dialog" aria-modal="true" aria-label={title}>
        <div className="picker-head">
          <h3>{title}</h3>
          <div className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>

        <div className="picker-tabs" role="tablist">
          <button
            role="tab" aria-selected={tab === 'all'}
            className={tab === 'all' ? 'on' : ''}
            onClick={() => setTab('all')}
          >All items</button>
          <button
            role="tab" aria-selected={tab === 'recommended'}
            className={tab === 'recommended' ? 'on' : ''}
            onClick={() => setTab('recommended')}
            disabled={!hasRecs}
            title={hasRecs ? 'Changes that bring your goals closer, and pieces with more card slots'
              : locked ? `${slot.label} is locked, so nothing is suggested for it`
                : 'Add goals in the Goals panel to get recommendations'}
          >Recommended</button>
        </div>

        {showRecs ? (
          <div className="picker-list">
            {smart && (
              <>
                <div className="rec-head">Towards your goals</div>
                {recommended.length === 0 && (
                  <div className="empty-note" style={{ padding: '4px 10px', fontSize: 12 }}>
                    Nothing here brings the goals any closer
                    {onlyUsable && className ? ` for ${className}` : ''}.
                  </div>
                )}
                {recommended.map(recRow)}
              </>
            )}
            {rollAdvice.length > 0 && (
              <>
                <div className="rec-head" title="A roll is luck, not a choice: this is what to hope for, at the top of each range">
                  Random options
                </div>
                {rollAdvice.map(recRow)}
              </>
            )}
            {moreSockets.length > 0 && (
              <>
                <div className="rec-head" title="Offered whatever the goals say: a spare socket is worth whatever card you put in it">
                  More card slots
                </div>
                {moreSockets.map(recRow)}
              </>
            )}
          </div>
        ) : (<>
        <div className="picker-filters">
          <input
            ref={searchRef}
            placeholder="Search name or effect…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">Any type</option>
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={minSlots} onChange={(e) => setMinSlots(e.target.value)}>
            <option value="">Any slots</option>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>{n}+ slots</option>
            ))}
          </select>
          <label className="level-range" title="Required level of the item">
            Lv
            <input
              type="number" min={0} placeholder="min"
              value={minLevel}
              onChange={(e) => setMinLevel(e.target.value)}
            />
            –
            <input
              type="number" min={0} placeholder="max"
              value={maxLevel}
              onChange={(e) => setMaxLevel(e.target.value)}
            />
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={onlyUsable}
              onChange={(e) => setOnlyUsable(e.target.checked)}
              disabled={!className}
            />
            My class
          </label>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as Sort)}
            aria-label="Sort by"
          >
            {smart && <option value="goals">Best for goals</option>}
            <option value="name">Name</option>
            <option value="level">Level</option>
          </select>
        </div>

        <div className="picker-list">
          {shown.length === 0 && (
            <div className="loading">Nothing matches those filters.</div>
          )}
          {shown.map((item) => (
            <button
              key={item.id}
              className="picker-row"
              onClick={() => onPick(item)}
              {...tooltipProps({ kind: 'item', item })}
            >
              <Icon item={item} />
              <div style={{ minWidth: 0 }}>
                <div>{item.name}</div>
                <div className="meta">
                  {item.type ?? item.kind}
                  {item.card_slots > 0 && ` · ${item.card_slots} slot${item.card_slots > 1 ? 's' : ''}`}
                  {item.required_level > 0 && ` · Lv ${item.required_level}`}
                  {item.sets.length > 0 && ` · ${dataset.sets[item.sets[0]]?.name} set`}
                  {item.enchant && ` · ${item.enchant.system} enchants`}
                </div>
                {smart && scores.has(item.id) && (
                  <Deltas
                    goals={goals}
                    before={before}
                    after={scores.get(item.id)!.after}
                    labelOf={labelOf}
                  />
                )}
              </div>
              <span className="stats">
                {item.atk ? `ATK ${item.atk} ` : ''}
                {item.matk ? `MATK ${item.matk} ` : ''}
                {item.def ? `DEF ${item.def} ` : ''}
                {item.mdef ? `MDEF ${item.mdef}` : ''}
              </span>
            </button>
          ))}
        </div>
        </>)}

        <div className="picker-foot">
          {showRecs ? (
            <span>
              {recommended.length + moreSockets.length + rollAdvice.length} recommendation
              {recommended.length + moreSockets.length + rollAdvice.length === 1 ? '' : 's'}
              {' '}· judged on the full build, sets and caps included
            </span>
          ) : (
            <span>
              {results.length} match{results.length === 1 ? '' : 'es'}
              {results.length > shown.length && ` — showing first ${shown.length}`}
            </span>
          )}
          <span>Esc to close</span>
        </div>
      </div>
    </div>
  );
}
