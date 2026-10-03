import { useEffect, useMemo, useState } from 'react';
import {
  aggregate, BASE_STAT_KEYS, coveredBy, groupCards, isRefineable, rankPlaystyles, SLOT_BY_KEY, socketsOf,
  type Build, type Dataset, type Item, type Totals,
} from '@sim';
import { encodeBuild } from '../share';
import { Icon } from './Icon';
import { tooltipProps } from './ItemTooltip';

/**
 * The whole build on one small screen (the project owner, 2026-10-02): four
 * tiles -- the gear and the shadow gear laid out like the game's equipment
 * window, each piece with its refine and cards; the stat allocation; and what
 * the build does to the training dummy -- to see or screenshot at a glance.
 */
const GEAR: { left: string[]; right: string[]; under: string[] } = {
  // The game's window: headgear top, then body, hands, garment, accessories; as the character faces you.
  // Lower headgear beside the upper and armour under the middle (the project owner, 2026-10-02).
  left: ['upper', 'lower', 'weapon', 'garment', 'acc1'],
  right: ['middle', 'armor', 'offhand', 'shoes', 'acc2'],
  under: ['gem', 'ammo'],
};
const SHADOW: { left: string[]; right: string[]; under: string[] } = {
  left: ['sh_armor', 'sh_gloves', 'sh_acc'],
  right: ['sh_shoes', 'sh_manual', 'runeorb'],
  under: [],
};
/** Short slot names for the empty cells. */
const SHORT: Record<string, string> = {
  upper: 'Upper', middle: 'Middle', lower: 'Lower', armor: 'Armor', weapon: 'Weapon', offhand: 'Off-hand',
  garment: 'Garment', shoes: 'Shoes', acc1: 'Accessory L', acc2: 'Accessory R', gem: 'Class Gem', ammo: 'Ammo',
  sh_armor: 'Armor', sh_shoes: 'Shoes', sh_gloves: 'Gloves', sh_acc: 'Accessory', sh_manual: 'Manual', runeorb: 'Rune / Orb',
};

export function EquipWindow({ dataset, build, onClose }: { dataset: Dataset; build: Build; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const totals = useMemo(() => aggregate(build, dataset), [build, dataset]);

  const cell = (key: string) => {
    const state = build.slots[key];
    const cover = coveredBy(build, key, dataset);
    const item: Item | null = state?.itemId ? dataset.items.get(state.itemId) ?? null : null;
    if (!item || cover) {
      return (
        <div className="eq-cell empty" key={key}>
          <div className="icon ph" />
          <span className="eq-text">
            <span className="eq-name">{cover ? `(${SHORT[cover]})` : SHORT[key] ?? SLOT_BY_KEY.get(key)?.label}</span>
            <span className="eq-cards" />
          </span>
        </div>
      );
    }
    const sockets = socketsOf(item, state.cards);
    const cards = groupCards(sockets).map((g) => ({ card: dataset.items.get(g.cardId), count: g.count })).filter((c) => c.card);
    const refine = isRefineable(item) && state.refine ? `+${state.refine} ` : '';
    return (
      <div className="eq-cell" key={key}
        {...tooltipProps({ kind: 'item', item, refine: state.refine, cards: sockets.map((id) => (id ? dataset.items.get(id) ?? null : null)) })}>
        <Icon item={item} />
        <span className="eq-text">
          <span className="eq-name" title={`${refine}${item.name}`}>{refine}{item.name}</span>
          {/* Always two lines tall, so every cell is the same height: "A + B" on one line when it fits, else two. */}
          <span className="eq-cards">
            {cards.map((c, i) => (
              <span key={c.card!.id}>{i > 0 ? ' + ' : ''}<span className="eq-card">{c.count > 1 ? `${c.count}× ` : ''}{c.card!.name.replace(/ Card$/, '')}</span></span>
            ))}
          </span>
        </span>
      </div>
    );
  };
  const pane = (title: string, layout: typeof GEAR) => (
    <section className="eq-tile">
      <h4>{title}</h4>
      <div className="eq-cols">
        <div>{layout.left.map(cell)}</div>
        <div>{layout.right.map(cell)}</div>
      </div>
      {layout.under.some((k) => build.slots[k]?.itemId) && (
        <div className="eq-cols">{layout.under.filter((k) => build.slots[k]?.itemId).map((k) => <div key={k}>{cell(k)}</div>)}</div>
      )}
    </section>
  );

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="picker equip-window" role="dialog" aria-label="The build at a glance">
        <div className="picker-head">
          <h3>{build.className ?? 'Build'} <span className="eq-level">Lv {build.baseLevel}</span></h3>
          <div className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>
        <div className="eq-body">
          {pane('Equipment', GEAR)}
          {pane('Shadow', SHADOW)}
          <StatsTile build={build} totals={totals} dataset={dataset} />
          <DummyTile build={build} dataset={dataset} />
        </div>
      </div>
    </div>
  );
}

const round = (x: number) => Math.round(x * 10) / 10;

/** Base points and what the gear adds to each, then the figures that decide a fight. */
function StatsTile({ build, totals, dataset }: { build: Build; totals: Totals; dataset: Dataset }) {
  const gear = (key: string) => {
    const id = dataset.stats.find((s) => s.key === key)?.id;
    return id !== undefined ? totals.byStat.get(id) : undefined;
  };
  const derived = (key: string) => totals.derived.find((d) => d.key === key)?.total;
  const pen = gear('def_pen')?.flat ?? 0;
  const lines: [string, number | undefined, string?][] = [
    ['Max HP', derived('max_hp')], ['Max SP', derived('max_sp')], ['CRIT', derived('crit_rate')],
    ['FLEE', derived('flee')], ['ASPD limit', derived('aspd_limit')], ['DEF', derived('def')], ['Penetration', pen, '%'],
  ];
  return (
    <section className="eq-tile">
      <h4>Stats</h4>
      <div className="eq-stats">
        {BASE_STAT_KEYS.map((k) => {
          const flat = gear(k)?.flat ?? 0;
          return (
            <div className="eq-stat" key={k}>
              <span className="eq-stat-name">{k.toUpperCase()}</span>
              <span>{build.baseStats[k]}</span>
              <span className={`eq-stat-bonus ${flat < 0 ? 'bad' : ''}`}>{flat ? `${flat > 0 ? '+' : ''}${round(flat)}` : ''}</span>
              <b>{round(build.baseStats[k] + flat)}</b>
            </div>
          );
        })}
      </div>
      <div className="eq-derived">
        {lines.filter(([, v]) => v !== undefined).map(([label, v, unit]) => (
          <div key={label}><span>{label}</span><b>{Math.round(v!).toLocaleString('en-US')}{unit ?? ''}</b></div>
        ))}
      </div>
    </section>
  );
}

interface Row { id: string; damage: number; share: number }

/**
 * Which build's rotation the dummy tile plays, per class: the farm profiles the sim's own builds came
 * from. A class with several builds (Night Raven) picks by playstyle -- the kit's generic order put
 * Counter Slash into a Definitive Dagger build (the project owner, 2026-10-02).
 */
const ROTATIONS: Record<string, { label: string; style?: string; profile: string }[]> = {
  'Night Raven': [
    { label: 'Counter Slash', style: 'Counter Slash / Typhoon (STR)', profile: 'nightraven-counter-commit' },
    { label: 'Definitive Dagger', style: 'Definitive Dagger (AGI/STR)', profile: 'nightraven-dd-final' },
    { label: 'Pure auto-attack', style: 'Pure auto-attack (crit)', profile: 'nightraven-aa-endgame' },
    { label: 'Raven auto-attack', style: 'Raven auto-attack (LUK)', profile: 'nightraven-raven-endgame' },
  ],
  Satsujin: [{ label: 'Moon', profile: 'satsujin-farm-maxed-a' }],
  Revenant: [{ label: 'Scythe', profile: 'revenant-maxed-final' }],
  Kingslayer: [{ label: 'Shield', profile: 'kingslayer-endgame-farm' }],
};
/**
 * The build on the training dummy for its 10 s: the combat sim, through the
 * local dev server (/__combat/run, as the Combat panel) -- not on the
 * published site, where there is no sim to run.
 */
function DummyTile({ build, dataset }: { build: Build; dataset: Dataset }) {
  const options = ROTATIONS[build.className ?? ''] ?? [];
  // The playstyle the base stats fit best (as the Goals panel picks), until the player picks another.
  const guess = useMemo(() => {
    const ranked = rankPlaystyles(dataset.classGoals?.[build.className ?? ''] ?? [], build.baseStats);
    return options.find((o) => o.style === ranked[0]?.style.name)?.profile ?? options[0]?.profile ?? null;
  }, [dataset, build.className, build.baseStats]); // eslint-disable-line react-hooks/exhaustive-deps
  const [picked, setPicked] = useState<string | null>(null);
  const profile = options.some((o) => o.profile === picked) ? picked : guess;
  const [state, setState] = useState<{ dps: number; dealt: number; seconds: number; top: Row[]; hp: number; sp: number; aspd: number } | 'running' | 'none' | string>('running');
  useEffect(() => {
    const ctl = new AbortController();
    setState('running');
    (async () => {
      try {
        const res = await fetch('/__combat/run', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl.signal,
          body: JSON.stringify({ build: await encodeBuild(build), vs: 'dummy', iter: 20, policy: 'priority', ...(profile ? { profile } : {}) }),
        });
        // The published site has no dev server behind it: any refusal means "no sim here".
        if (!res.ok || !res.body) { setState('none'); return; }
        const text = await res.text();
        let fighter: { maxHp: number; maxSp: number; aspd: number } | null = null;
        for (const line of text.split('\n').filter((l) => l.trim())) {
          const msg = JSON.parse(line);
          if (msg.type === 'start') fighter = msg.fighter;
          else if (msg.type === 'error') { setState(msg.error); return; }
          else if (msg.type === 'result') {
            const r = msg.result;
            const top = [...(r.actions ?? [])].filter((a: Row) => a.damage > 0).sort((a: Row, b: Row) => b.damage - a.damage).slice(0, 4);
            setState({ dps: r.dps, dealt: r.dps * r.seconds, seconds: r.seconds, top, hp: fighter?.maxHp ?? 0, sp: fighter?.maxSp ?? 0, aspd: fighter?.aspd ?? 0 });
          }
        }
      } catch (e) {
        if (!ctl.signal.aborted) setState(e instanceof SyntaxError ? 'none' : e instanceof Error ? e.message : String(e));
      }
    })();
    return () => ctl.abort();
  }, [build, profile]);

  return (
    <section className="eq-tile">
      <h4 className="eq-dummy-head">
        Training dummy
        {options.length > 1 && (
          <select value={profile ?? ''} onChange={(e) => setPicked(e.target.value)} aria-label="Which build's rotation">
            {options.map((o) => <option key={o.profile} value={o.profile}>{o.label}</option>)}
          </select>
        )}
      </h4>
      {state === 'running' && <p className="eq-note">Running the sim…</p>}
      {state === 'none' && <p className="eq-note">The combat sim runs on the local dev server only.</p>}
      {typeof state === 'string' && state !== 'running' && state !== 'none' && <p className="eq-note">Could not run: {state}</p>}
      {typeof state === 'object' && (() => {
        return (
          <>
            <div className="eq-dps"><b>{Math.round(state.dps).toLocaleString('en-US')}</b> DPS</div>
            <p className="eq-note">{Math.round(state.dealt).toLocaleString('en-US')} damage in {round(state.seconds)} s, {options.length ? "the sim build's rotation" : "the kit's default rotation"}; the dummy has no DEF.</p>
            <div className="eq-derived">
              {state.top.map((r) => <div key={r.id}><span>{r.id}</span><b>{Math.round(100 * r.share)}%</b></div>)}
            </div>
            <div className="eq-derived">
              <div><span>Max HP (sim)</span><b>{Math.round(state.hp).toLocaleString('en-US')}</b></div>
              <div><span>Max SP (sim)</span><b>{Math.round(state.sp).toLocaleString('en-US')}</b></div>
              <div><span>ASPD (sim)</span><b>{state.aspd}</b></div>
            </div>
          </>
        );
      })()}
    </section>
  );
}
