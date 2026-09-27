import { useEffect, useMemo, useRef, useState } from 'react';
import {
  canEquip, fitsCard, fitsSlot, isRefineable, maxRefine, SLOTS, socketsOf,
  type Build, type Dataset, type Item, type MobInfo, type SlotDef,
} from '@sim';
import { loadSpawns } from '../data';
import { Icon } from './Icon';
import { ItemCard } from './ItemTooltip';
import { Source } from './SourcesPanel';

/** Rows rendered at once; the count in the foot says how many matched. */
const SHOWN = 400;

type Sort = 'name' | 'level' | 'id';

/**
 * Every item in the game, not just what fits one slot.
 *
 * The picker answers "what goes here?"; this answers "what is this?" --
 * materials, costumes, consumables and cards included. The list is the same
 * plain filter over the in-memory dataset as the picker. The detail is the
 * tooltip's own card, pinned open, with a refine to read it at, where it
 * can be worn, and where it comes from.
 */
export function ItemCodex({ dataset, build, initial, onSelect, onEquip, onSocket, onClose }: {
  dataset: Dataset;
  build: Build;
  /** The item shown when the codex opens: the last one looked at. */
  initial: number | null;
  /** Remembered by the app, so reopening lands on the same item. */
  onSelect: (id: number) => void;
  onEquip: (slot: SlotDef, item: Item) => void;
  /** Put a card into the first empty socket of a slot. */
  onSocket: (slot: SlotDef, socket: number, card: Item) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [type, setType] = useState('');
  const [minSlots, setMinSlots] = useState('');
  const [minLevel, setMinLevel] = useState('');
  const [maxLevel, setMaxLevel] = useState('');
  const [onlyUsable, setOnlyUsable] = useState(false);
  const [sort, setSort] = useState<Sort>('name');
  const [selected, setSelected] = useState<number | null>(initial);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => { searchRef.current?.focus(); }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const kinds = useMemo(() => {
    const count = new Map<string, number>();
    for (const i of dataset.itemList) count.set(i.kind, (count.get(i.kind) ?? 0) + 1);
    return [...count].sort((a, b) => a[0].localeCompare(b[0]));
  }, [dataset.itemList]);

  // Types narrow with the category, so the list is never mostly options
  // that would match nothing.
  const types = useMemo(() => {
    const set = new Set<string>();
    for (const i of dataset.itemList) if (i.type && (!kind || i.kind === kind)) set.add(i.type);
    return [...set].sort();
  }, [dataset.itemList, kind]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    // A bare number is also an item id, the way the database links them.
    const id = /^\d+$/.test(q) ? Number(q) : null;
    const min = minSlots ? Number(minSlots) : 0;
    const lo = minLevel.trim() === '' ? null : Number(minLevel);
    const hi = maxLevel.trim() === '' ? null : Number(maxLevel);
    const out = dataset.itemList.filter((item) => {
      if (kind && item.kind !== kind) return false;
      if (type && item.type !== type) return false;
      if (min && item.card_slots < min) return false;
      if (lo !== null && Number.isFinite(lo) && item.required_level < lo) return false;
      if (hi !== null && Number.isFinite(hi) && item.required_level > hi) return false;
      if (onlyUsable && !canEquip(item, build.className, dataset.classRules)) return false;
      if (!q) return true;
      return item.id === id
        || item.name.toLowerCase().includes(q)
        || item.description.toLowerCase().includes(q);
    });
    const byName = (a: Item, b: Item) => a.name.localeCompare(b.name) || a.id - b.id;
    if (sort === 'level') out.sort((a, b) => b.required_level - a.required_level || byName(a, b));
    else if (sort === 'id') out.sort((a, b) => a.id - b.id);
    else out.sort(byName);
    // An exact id or name first, whatever the sort: that is what was typed.
    if (q) {
      const exact = out.findIndex((i) => i.id === id || i.name.toLowerCase() === q);
      if (exact > 0) out.unshift(...out.splice(exact, 1));
    }
    return out;
  }, [dataset.itemList, dataset.classRules, build.className, query, kind, type, minSlots,
    minLevel, maxLevel, onlyUsable, sort]);

  const shown = results.slice(0, SHOWN);
  const item = selected !== null ? dataset.items.get(selected) ?? null : null;

  const select = (id: number) => { setSelected(id); onSelect(id); };

  // Up and down walk the list from the search box, so the codex can be read
  // item by item without reaching for the mouse.
  const step = (by: number) => {
    if (shown.length === 0) return;
    const at = shown.findIndex((i) => i.id === selected);
    const next = shown[Math.min(shown.length - 1, Math.max(0, at < 0 ? 0 : at + by))];
    select(next.id);
    listRef.current?.querySelector(`[data-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' });
  };

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="picker codex" role="dialog" aria-modal="true" aria-label="Item codex">
        <div className="picker-head">
          <h3>Item codex</h3>
          <span className="focus-sub">every item, any slot</span>
          <div className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>

        <div className="picker-filters codex-filters">
          <input
            ref={searchRef}
            placeholder="Search name, effect or id…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); step(1); }
              if (e.key === 'ArrowUp') { e.preventDefault(); step(-1); }
            }}
          />
          <select value={kind} onChange={(e) => { setKind(e.target.value); setType(''); }}
            aria-label="Category">
            <option value="">Any category</option>
            {kinds.map(([k, n]) => <option key={k} value={k}>{k} ({n})</option>)}
          </select>
          <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
            <option value="">Any type</option>
            {types.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
          <select value={minSlots} onChange={(e) => setMinSlots(e.target.value)}
            aria-label="Card slots">
            <option value="">Any slots</option>
            {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n}+ slots</option>)}
          </select>
          <label className="level-range" title="Required level of the item">
            Lv
            <input type="number" min={0} placeholder="min" value={minLevel}
              onChange={(e) => setMinLevel(e.target.value)} />
            –
            <input type="number" min={0} placeholder="max" value={maxLevel}
              onChange={(e) => setMaxLevel(e.target.value)} />
          </label>
          <label className="check" title={build.className
            ? `Only what ${build.className} can wear` : 'Pick a class first'}>
            <input type="checkbox" checked={onlyUsable} disabled={!build.className}
              onChange={(e) => setOnlyUsable(e.target.checked)} />
            My class
          </label>
          <select value={sort} onChange={(e) => setSort(e.target.value as Sort)}
            aria-label="Sort by">
            <option value="name">Name</option>
            <option value="level">Level</option>
            <option value="id">Id</option>
          </select>
        </div>

        <div className="codex-body">
          <div className="picker-list codex-list" ref={listRef}>
            {shown.length === 0 && <div className="loading">Nothing matches those filters.</div>}
            {shown.map((i) => (
              <button
                key={i.id}
                data-id={i.id}
                className={`picker-row ${i.id === selected ? 'on' : ''}`}
                onClick={() => select(i.id)}
              >
                <Icon item={i} />
                <div style={{ minWidth: 0 }}>
                  <div className="codex-name">{i.name}</div>
                  <div className="meta">
                    {i.type ?? i.kind}
                    {i.card_slots > 0 && ` · ${i.card_slots} slot${i.card_slots > 1 ? 's' : ''}`}
                    {i.required_level > 0 && ` · Lv ${i.required_level}`}
                  </div>
                </div>
              </button>
            ))}
          </div>

          <div className="codex-detail">
            {item
              ? <Detail key={item.id} item={item} dataset={dataset} build={build}
                  onOpen={select} onEquip={onEquip} onSocket={onSocket} />
              : <div className="loading">Pick an item to read it.</div>}
          </div>
        </div>

        <div className="picker-foot">
          <span>
            {results.length.toLocaleString()} of {dataset.itemList.length.toLocaleString()} items
            {results.length > shown.length && ` — showing first ${shown.length}`}
          </span>
          <span>↑↓ from the search box · Esc to close</span>
        </div>
      </div>
    </div>
  );
}

/** One item, pinned open: the tooltip card and what the tooltip cannot say. */
function Detail({ item, dataset, build, onOpen, onEquip, onSocket }: {
  item: Item;
  dataset: Dataset;
  build: Build;
  onOpen: (id: number) => void;
  onEquip: (slot: SlotDef, item: Item) => void;
  onSocket: (slot: SlotDef, socket: number, card: Item) => void;
}) {
  const isCard = item.kind === 'Card';
  // A card is read at the refine of the piece it would sit in, so the
  // stepper drives its per-refine lines the same way.
  const scales = isCard
    ? item.refine.per_refine.length > 0 || item.refine.thresholds.length > 0
    : isRefineable(item);
  const top = isCard ? 10 : maxRefine(item);
  const [refine, setRefine] = useState(0);

  const [mobs, setMobs] = useState<Map<number, MobInfo> | null>(null);
  useEffect(() => {
    let live = true;
    loadSpawns().then((m) => { if (live) setMobs(m); }).catch(() => { /* drops still list */ });
    return () => { live = false; };
  }, []);

  // Held to the class's rules per slot, the way the picker is: a weapon
  // fits the off hand only for a class that dual wields, and a Satsujin
  // holds daggers alone.
  const fits = isCard ? [] : SLOTS.filter((s) => fitsSlot(item, s));
  const wearable = fits.filter((s) => canEquip(item, build.className, dataset.classRules, s.key));
  const barred = fits.filter((s) => !wearable.includes(s));
  // Where a card can go right now: a slot whose piece takes it and still
  // has a socket free.
  const sockets = isCard
    ? SLOTS.flatMap((s) => {
      const state = build.slots[s.key];
      const host = dataset.items.get(state?.itemId ?? -1);
      if (!host || !fitsCard(item, s, host)) return [];
      const free = socketsOf(host, state.cards).indexOf(null);
      return free < 0 ? [] : [{ slot: s, socket: free, host }];
    })
    : [];
  const fitsAny = isCard && SLOTS.some((s) => fitsCard(item, s, null));
  const sets = item.sets.map((i) => dataset.sets[i]).filter(Boolean);

  return (
    <>
      <div className="codex-bar">
        <span className="pill">#{item.id}</span>
        {scales && (
          <label className="codex-refine" title={isCard
            ? 'Refine of the piece this card sits in' : 'Read the item at this refine'}>
            {isCard ? 'Host +' : '+'}
            <input type="range" min={0} max={top} value={refine}
              onChange={(e) => setRefine(Number(e.target.value))} />
            <b>{refine}</b>
          </label>
        )}
        <div className="spacer" />
        {item.source_url && (
          <a href={item.source_url} target="_blank" rel="noreferrer">Database ↗</a>
        )}
      </div>

      <div className="codex-card">
        <ItemCard kind="item" item={item} dataset={dataset}
          refine={isCard ? 0 : refine} hostRefine={isCard ? refine : 0} />
      </div>

      {(fits.length > 0 || isCard) && (
        <section className="codex-sec">
          <h4>{isCard ? 'Socket into' : 'Equip in'}</h4>
          {barred.length > 0 && (
            <p className="empty-note">
              {wearable.length === 0
                ? `${build.className} cannot wear this.`
                : `${build.className} cannot hold it in: ${barred.map((s) => s.label).join(', ')}.`}
            </p>
          )}
          <div className="codex-actions">
            {wearable.map((s) => (
              <button key={s.key} onClick={() => onEquip(s, item)}
                title={build.slots[s.key]?.itemId
                  ? `Replaces ${dataset.items.get(build.slots[s.key].itemId!)?.name ?? 'what is there'}`
                  : 'Empty slot'}>
                {s.label}
              </button>
            ))}
            {sockets.map(({ slot, socket, host }) => (
              <button key={slot.key} onClick={() => onSocket(slot, socket, item)}
                title={`Socket ${socket + 1} of ${host.name}`}>
                {slot.label}
              </button>
            ))}
          </div>
          {isCard && sockets.length === 0 && (
            <p className="empty-note">
              {fitsAny
                ? 'Nothing worn that takes this card has a free socket.'
                : 'No equipment slot in the planner takes this card.'}
            </p>
          )}
        </section>
      )}

      {sets.map((set) => (
        <section className="codex-sec" key={set.index}>
          <h4>{set.name} set</h4>
          <div className="codex-members">
            {set.members.map((m) => {
              const piece = dataset.items.get(m.id);
              return (
                <button key={m.id} className={`picker-row ${m.id === item.id ? 'on' : ''}`}
                  disabled={!piece} onClick={() => onOpen(m.id)}>
                  {piece && <Icon item={piece} />}
                  <span>{m.name}</span>
                </button>
              );
            })}
          </div>
        </section>
      ))}

      <section className="codex-sec">
        <h4>Where it comes from</h4>
        <Source item={item} role={item.type ?? item.kind} mobs={mobs} />
      </section>
    </>
  );
}
