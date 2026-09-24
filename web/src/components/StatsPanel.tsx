import { useMemo, useState } from 'react';
import {
  completeSet, skillTone, statTone,
  type Build, type Dataset, type SetRecord, type SlotChange, type StatTotal,
  type Totals,
} from '@sim';
import { tooltipProps } from './ItemTooltip';

/**
 * Total stats.
 *
 * Flat and percent sit in separate columns rather than being combined into
 * one figure. They stack differently in Ragnarok, and a single number would
 * imply this tool knows the order they apply in -- it does not yet.
 */
export function StatsPanel({ totals, dataset }: { totals: Totals; dataset: Dataset }) {
  const rows = useMemo(() => {
    const byCategory = new Map<string, {
      key: string; name: string; flat: number; percent: number;
      sources: StatTotal['sources'];
    }[]>();
    for (const total of totals.byStat.values()) {
      const def = dataset.statById.get(total.statId);
      if (!def) continue;
      if (total.flat === 0 && total.percent === 0) continue;
      const list = byCategory.get(def.category) ?? [];
      list.push({ key: def.key, name: def.name, flat: total.flat,
        percent: total.percent, sources: total.sources });
      byCategory.set(def.category, list);
    }
    for (const list of byCategory.values()) list.sort((a, b) => a.name.localeCompare(b.name));
    return [...byCategory.entries()].sort((a, b) =>
      ORDER.indexOf(a[0]) - ORDER.indexOf(b[0]));
  }, [totals, dataset]);

  return (
    <div className="panel">
      <h2>Total Stats</h2>

      <ElementRow totals={totals} />

      {rows.length === 0 && (
        <p className="empty-note">Equip something to see totals.</p>
      )}
      {rows.map(([category, list]) => (
        <div key={category}>
          <div className="stat-cat">{label(category)}</div>
          {list.map((row) => (
            <div
              className="stat-row"
              key={row.name}
              tabIndex={0}
              {...tooltipProps({
                kind: 'stat',
                name: row.name,
                // A flag is a property, not an amount, so its hover lists
                // what granted it and leaves the numbers off.
                statKey: category === 'flag' ? null : row.key,
                sources: row.sources,
                flat: row.flat,
                percent: row.percent,
              })}
            >
              <span className="n">{row.name}</span>
              {/* A flag is a property, not a quantity: two sources of
                  "Unbreakable Weapon" is still just unbreakable, so the
                  count is deliberately not shown as a total. */}
              {category === 'flag' ? (
                <span className="v flag">yes</span>
              ) : (
                <>
                  <span className={`v flat ${row.flat ? statTone(row.key, row.flat) ?? '' : 'zero'}`}>
                    {row.flat ? fmt(row.flat) : '·'}
                  </span>
                  <span className={`v pct ${row.percent ? statTone(row.key, row.percent) ?? '' : 'zero'}`}>
                    {row.percent ? `${fmt(row.percent)}%` : '·'}
                  </span>
                </>
              )}
            </div>
          ))}
        </div>
      ))}

      <SkillRows totals={totals} />
    </div>
  );
}

/**
 * Bonuses to one skill: "Backstab damage +24%", "Heal cooldown -2 s".
 *
 * Totalled per skill rather than folded into a damage stat -- a skill's
 * bonus says nothing about any other attack -- and listed after the stats,
 * collapsed past a handful, because a build can carry dozens.
 */
function SkillRows({ totals }: { totals: Totals }) {
  const [open, setOpen] = useState(false);
  const rows = useMemo(() => [...totals.skills.values()]
    .filter((s) => s.flat !== 0 || s.percent !== 0)
    .sort((a, b) => a.skill.localeCompare(b.skill) || a.metric.localeCompare(b.metric)),
  [totals]);
  if (rows.length === 0) return null;
  const LIMIT = 8;
  const shown = open ? rows : rows.slice(0, LIMIT);
  return (
    <div>
      <div className="stat-cat">skill modifiers</div>
      {shown.map((s) => (
        <div
          className="stat-row" key={`${s.skill}|${s.metric}`}
          tabIndex={0}
          {...tooltipProps({
            kind: 'stat', name: `${s.skill} ${s.metric}`, statKey: null,
            metric: s.metric, sources: s.sources, flat: s.flat, percent: s.percent,
          })}
        >
          <span className="n">{s.skill} {s.metric}</span>
          <span className={`v flat ${s.flat ? skillTone(s.metric, s.flat) ?? '' : 'zero'}`}>
            {s.flat ? `${fmt(s.flat)}${s.unit ? ` ${s.unit}` : ''}` : '·'}
          </span>
          <span className={`v pct ${s.percent ? skillTone(s.metric, s.percent) ?? '' : 'zero'}`}>
            {s.percent ? `${fmt(s.percent)}%` : '·'}
          </span>
        </div>
      ))}
      {rows.length > LIMIT && (
        <button className="more" onClick={() => setOpen(!open)}>
          {open ? 'Show fewer' : `Show all ${rows.length}`}
        </button>
      )}
    </div>
  );
}

/**
 * The element the character ends up with.
 *
 * Only one piece can set it, so when several claim it the losing claims are
 * shown struck through rather than hidden — otherwise a player swapping in
 * a second element armour would see no change and no reason why.
 */
function ElementRow({ totals }: { totals: Totals }) {
  if (totals.elementClaims.length === 0) return null;
  const overridden = totals.elementClaims.filter((c) => !c.applied);

  return (
    <div className="element-row">
      <span className="n">Element</span>
      <span className={`elem elem--${(totals.element ?? '').toLowerCase()}`}>
        {totals.element ?? 'Neutral'}
      </span>
      {overridden.length > 0 && (
        <span className="elem-lost" title={overridden
          .map((c) => `${c.element} from ${c.source}`).join('\n')}>
          {overridden.length} override{overridden.length > 1 ? 's' : ''} ignored
        </span>
      )}
    </div>
  );
}

export function SetsPanel({ totals, build, dataset, onFill }: {
  totals: Totals;
  build: Build;
  dataset: Dataset;
  /** Put on the rest of a set, all at once. */
  onFill: (changes: SlotChange[]) => void;
}) {
  if (totals.setProgress.length === 0) return null;
  return (
    <div className="panel">
      <h2>Sets</h2>
      {totals.setProgress.map((progress) => {
        const { set, worn, total, complete, setRefine } = progress;
        return (
        <div
          className="set-row"
          key={set.index}
          tabIndex={0}
          {...tooltipProps({ kind: 'set', progress })}
        >
          <span className={`pill ${complete ? 'done' : ''}`}>{worn}/{total}</span>
          <span style={{ flex: 1 }}>{set.name}</span>
          {!complete && (
            <FillSetButton set={set} build={build} dataset={dataset} onFill={onFill} />
          )}
          {set.override && (
            // The tooltip for this set was ambiguous enough to be corrected
            // by hand. Say so, rather than presenting a reading as a reading
            // of the game.
            <span
              className={`pill ${set.override.status === 'verified' ? '' : 'unverified'}`}
              title={`${set.override.status === 'verified'
                ? 'Hand-corrected and checked in game'
                : 'Hand-corrected, not yet checked in game'}\n\n${set.override.reason}`}
            >
              {set.override.status === 'verified' ? 'corrected' : 'unverified'}
            </span>
          )}
          {complete && setRefine > 0 && (
            <span className="pill" title="Summed refine of the whole set">
              set +{setRefine}
            </span>
          )}
        </div>
        );
      })}
    </div>
  );
}

/**
 * "Put the rest of this set on."
 *
 * A set is worth nothing until the last piece goes on, so hunting down four
 * shadow pieces one slot at a time is work with no reward until the end of
 * it. One piece on is enough to name the set; this does the rest.
 *
 * It says up front what it is about to do, and refuses rather than half-does
 * it when a piece has nowhere to go -- a locked slot, or no slot that takes
 * it at all. A set put on halfway is a set that does nothing.
 */
function FillSetButton({ set, build, dataset, onFill }: {
  set: SetRecord;
  build: Build;
  dataset: Dataset;
  onFill: (changes: SlotChange[]) => void;
}) {
  const fill = useMemo(() => completeSet(build, set, dataset), [build, set, dataset]);
  if (fill.need === 0) return null;

  const name = (id: number) => dataset.items.get(id)?.name ?? `#${id}`;
  const ready = fill.placed.length === fill.need;
  const replaced = fill.changes
    .filter((c) => {
      const had = build.slots[c.slot]?.itemId;
      return had && had !== c.state.itemId;
    })
    .map((c) => name(build.slots[c.slot]!.itemId!));

  return (
    <button
      className="fill-set"
      disabled={!ready}
      onClick={() => ready && onFill(fill.changes)}
      title={ready
        ? [
          `Equip ${fill.placed.map(name).join(', ')}`,
          replaced.length > 0 ? `Takes off ${replaced.join(', ')}` : null,
          'Refines and cards already in those slots are kept where they fit.',
        ].filter(Boolean).join('\n')
        : `Nowhere to put ${fill.blocked.map(name).join(', ')} — `
          + 'either no slot takes it, or the slot it needs is locked.'}
    >
      Fill
    </button>
  );
}

/**
 * Effects that are real but were not added into the totals.
 *
 * This panel exists so the totals can be trusted. Without it a conditional
 * bonus or a per-skill modifier would simply vanish, and the numbers above
 * would look more complete than they are.
 */
export function UncountedPanel({ totals }: { totals: Totals }) {
  const [open, setOpen] = useState(false);
  if (totals.uncounted.length === 0) return null;

  return (
    <div className="panel">
      <h2>
        Not counted ({totals.uncounted.length})
        <button
          style={{ float: 'right', padding: '2px 8px', fontSize: 11 }}
          onClick={() => setOpen(!open)}
        >
          {open ? 'Hide' : 'Show'}
        </button>
      </h2>
      {open && (
        <div className="uncounted">
          {totals.uncounted.map((u, i) => (
            <div key={i}>
              {u.text}
              <div className="why">{u.label} — {u.reason}</div>
            </div>
          ))}
        </div>
      )}
      {!open && (
        <p className="empty-note" style={{ margin: 0, fontSize: 12 }}>
          Conditional and base-stat bonuses the totals leave out, and skill
          bonuses that name no one skill.
        </p>
      )}
    </div>
  );
}

const ORDER = [
  'flag',
  'primary', 'resource', 'offence', 'defence', 'casting', 'cost', 'utility',
  'element_damage', 'element_resist', 'race_damage', 'race_resist',
  'size_damage', 'size_defence', 'status_resist',
];

function label(category: string) {
  return category.replace(/_/g, ' ');
}

function fmt(n: number) {
  const rounded = Math.round(n * 100) / 100;
  return rounded > 0 ? `+${rounded}` : `${rounded}`;
}
