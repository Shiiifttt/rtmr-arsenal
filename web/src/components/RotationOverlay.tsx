import { createContext, useContext, useEffect, useMemo, useState } from 'react';

/**
 * The recommended rotation for the build's class, from the combat sim
 * (data/rotations.json, written by combat/tools/build-rotations.ts):
 *
 *   - All-round: what the class's farm build plays over the endgame areas,
 *     read off a long fight so the loop shows;
 *   - Dummy: the rotation that does the most damage on the training dummy.
 *
 * Skills are icons joined by arrows. Hovering one shows a plain-words summary,
 * the tooltip's numbers, and each stat scaling worked out on this build's
 * stats ("+2% per LUK · LUK 105 → +210%"). Pre-fight buffs list what each is
 * worth on the dummy (its skill taken off, the same fights).
 */

type Stat = 'STR' | 'AGI' | 'VIT' | 'INT' | 'DEX' | 'LUK';
interface Scaling { stats: Stat[]; per: number; every: number; text: string }
interface SkillInfo { name: string; icon: string; level: number; desc: string; summary: string | null; scalings: Scaling[] }
/** A buff, combo state or debuff the kit tracks, as it stands after a step. */
interface StatusMark { label: string; stacks?: number; leftMs?: number; value?: number; onTarget?: boolean }
/** After each step: what's up, and what the step set off by itself (autocasts). */
interface Mark { states: StatusMark[]; procs: string[] }
interface Rotation {
  opener: string[];
  openerMarks?: Mark[];
  cycles: { steps: string[]; share: number; marks?: Mark[] }[];
  /** Off-loop casts per loop; `auto` ones the game makes by itself (Haunting Slice's Scythe Reap). */
  fillers: { id: string; perLoop: number; auto?: boolean }[];
  roles: { role: string; share: number }[];
  /** Every damaging action: share of all damage, and average damage per cast. */
  damage: { id: string; share: number; perCast: number | null }[];
  prep: string[];
  dps: number;
}
interface ClassRotations {
  /** Set when a class has several builds: the entry is keyed "<class>: <build>" (Night Raven). */
  className?: string;
  build: string; note: string; profileName: string;
  allround: Rotation & { vs: string };
  dummy: Rotation & { seconds: number };
  /**
   * `optional`: up or not by choice (Rook's Wall). `vsGain`: worth nothing on
   * the dummy but this much in the all-round fight (Magic Pierce: the dummy has no DEF).
   */
  buffs: { skill: string; icon: string; dpsGain: number | null; vsGain?: number; required?: boolean; optional?: boolean }[];
  skills: Record<string, SkillInfo>;
}
interface RotationFile { builtAt: string; classes: Record<string, ClassRotations> }

/**
 * The tile or arrow being hovered and where it sits: the overlay draws one
 * floating tooltip for it (a tooltip inside the scrolling list gets clipped).
 * An arrow carries the states after the step before it.
 */
type Hover = { rect: DOMRect } & ({ id: string; dmg?: string; states?: undefined } | { id?: undefined; states: StatusMark[]; after: string });
const HoverCtx = createContext<(h: Hover | null) => void>(() => {});
/** The rotation's damage by action, for the combo breakdowns and the tooltip. */
type DamageMap = Map<string, { share: number; perCast: number | null }>;
const DamageCtx = createContext<DamageMap>(new Map());
/** The sim books an autocast's damage apart ("Scythe Reap (autocast)"); an AUTO tile reads that row when there is one. */
const autoKey = (damage: DamageMap, id: string) => (damage.has(`${id} (autocast)`) ? `${id} (autocast)` : id);
const k1 = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : `${Math.round(n)}`);

const STAT_COLOR: Record<Stat, string> = {
  STR: '#ff7b72', AGI: '#7ee787', VIT: '#ffa657', INT: '#79c0ff', DEX: '#f2cc60', LUK: '#ff9bce',
};

/** Not skills: moves the sim makes between them. Shown as a plain chip, if at all. */
const MOVE_LABEL: Record<string, string> = { Attack: 'Auto-attack' };

export function RotationOverlay({
  className, stats, onClose,
}: {
  className: string | null;
  /** The build's total base stats (points + gear), for the scaling lines. */
  stats: Record<Stat, number>;
  onClose: () => void;
}) {
  const [file, setFile] = useState<RotationFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<'allround' | 'dummy'>('allround');
  const [picked, setPicked] = useState<string | null>(null);
  const [hover, setHover] = useState<Hover | null>(null);

  useEffect(() => {
    fetch('./data/rotations.json')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`rotations: HTTP ${r.status}`))))
      .then(setFile, (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const classes = useMemo(() => Object.keys(file?.classes ?? {}), [file]);
  // The build's class: its own entry, or the first of its builds ("Night Raven: Counter Slash").
  const ofClass = (k: string) => (file?.classes[k]?.className ?? k) === className;
  const cls = picked ?? (className ? classes.find(ofClass) : undefined) ?? classes[0] ?? null;
  const data = cls ? file?.classes[cls] : null;
  const rot = data ? data[tab] : null;
  const damage: DamageMap = useMemo(() => new Map((rot?.damage ?? []).map((d) => [d.id, { share: d.share, perCast: d.perCast }])), [rot]);

  return (
    <HoverCtx.Provider value={setHover}>
    <DamageCtx.Provider value={damage}>
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="picker rotation-overlay">
        <div className="picker-head">
          <h3>Rotation</h3>
          {classes.length > 0 && (
            <select value={cls ?? ''} onChange={(e) => setPicked(e.target.value)} style={{ width: 240 }}>
              {classes.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          <div className="rot-tabs">
            <button className={tab === 'allround' ? 'on' : ''} onClick={() => setTab('allround')}
              title="What the class's farm build plays over the endgame areas">All-round</button>
            <button className={tab === 'dummy' ? 'on' : ''} onClick={() => setTab('dummy')}
              title="The rotation that does the most damage on the training dummy">Dummy (max damage)</button>
          </div>
          <div className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>

        <div className="picker-list rot-body">
          {error && <p className="empty-note">Could not load the rotations: {error}</p>}
          {!file && !error && <p className="empty-note">Loading…</p>}
          {file && !data && <p className="empty-note">No rotation for this class yet: only classes with a combat-sim kit have one.</p>}
          {data && rot && (
            <>
              {className && className !== (data.className ?? cls) && (
                <p className="rot-note">Your build is {className}; showing {cls}.</p>
              )}
              <p className="rot-note">
                {tab === 'allround'
                  ? <>Played by the {data.note}{data.className ? '' : ' over the ten endgame areas'}; the loop is read off a long fight against {data.allround.vs}.</>
                  : <>The most damage on the training dummy over {data.dummy.seconds} s, on the same build.</>}
                {' '}{Math.round(rot.dps).toLocaleString('en-US')} DPS there.{' '}
                <a href={data.build} target="_blank" rel="noreferrer">Open that build</a>
              </p>

              <Section title="Before the pull">
                <div className="rot-buffs">
                  {data.buffs.map((b) => (
                    <div className="rot-buff" key={b.skill}>
                      <SkillTile id={b.skill} skills={data.skills} stats={stats} badge={b.optional ? 'OPTIONAL' : undefined} />
                      <span className={`rot-gain ${b.required ? 'req' : b.dpsGain || b.vsGain ? '' : 'def'}`}
                        title={b.vsGain ? `Nothing on the dummy; in the fight against ${data.allround.vs}` : undefined}>
                        {b.required ? 'required' : b.dpsGain ? `+${(100 * b.dpsGain).toFixed(1)}% DPS`
                          : b.vsGain ? `+${(100 * b.vsGain).toFixed(1)}% vs ${data.allround.vs}` : 'defensive'}
                      </span>
                    </div>
                  ))}
                </div>
                {rot.prep.length > 0 && <p className="rot-sub">Up at the pull here: {rot.prep.join(' · ')}</p>}
              </Section>

              <Section title="Opener">
                <Chain steps={rot.opener} marks={rot.openerMarks} skills={data.skills} stats={stats} />
              </Section>

              {rot.cycles.length > 0 && (
                <Section title="Core loop">
                  {rot.cycles.map((c, i) => (
                    <Chain key={i} steps={c.steps} marks={c.marks} skills={data.skills} stats={stats} loop share={c.share} />
                  ))}
                </Section>
              )}

              {rot.fillers.length > 0 && (
                <Section title="Fillers, per loop">
                  <div className="rot-chain">
                    {rot.fillers.map((x) => (
                      <div className="rot-filler" key={x.id}>
                        <SkillTile id={x.id} skills={data.skills} stats={stats} auto={x.auto} />
                        <span className="rot-share">×{x.perLoop}</span>
                      </div>
                    ))}
                  </div>
                </Section>
              )}

              <Section title="Where the damage comes from">
                <div className="rot-bars">
                  {rot.damage.filter((d) => d.share >= 0.01).map((d) => (
                    <div className="rot-bar" key={d.id}>
                      <span>{MOVE_LABEL[d.id] ?? d.id}</span>
                      <div><i style={{ width: `${Math.round(d.share * 100)}%` }} /></div>
                      <span>{Math.round(d.share * 100)}%</span>
                    </div>
                  ))}
                </div>
              </Section>
            </>
          )}
        </div>
        <div className="picker-foot">
          <span>From the combat sim{file ? `, ${file.builtAt.slice(0, 10)}` : ''}. Hover a skill for what it does and how it scales on your stats, an arrow for what's up at that point.</span>
          <span>Esc to close</span>
        </div>
      </div>
      {hover && data && (hover.states
        ? <StateTip rect={hover.rect} states={hover.states} after={hover.after} />
        : <SkillTip rect={hover.rect} id={hover.id} dmg={hover.dmg} skills={data.skills} stats={stats} damage={damage} />)}
    </div>
    </DamageCtx.Provider>
    </HoverCtx.Provider>
  );
}

/** Where a floating tooltip goes: below the hovered thing, or above it near the bottom, kept inside the window. */
function tipStyle(rect: DOMRect, W: number) {
  const left = Math.max(8, Math.min(window.innerWidth - W - 8, rect.left + rect.width / 2 - W / 2));
  const below = rect.bottom + 8;
  return below > window.innerHeight * 0.55
    ? { left, bottom: window.innerHeight - rect.top + 8, width: W }
    : { left, top: below, width: W };
}

/** An arrow's tooltip: your buffs and combo states, then the target's debuffs, as they stand after the step before it. */
function StateTip({ rect, states, after }: { rect: DOMRect; states: StatusMark[]; after: string }) {
  const mine = states.filter((m) => !m.onTarget);
  const theirs = states.filter((m) => m.onTarget);
  const row = (m: StatusMark) => (
    <span className={`rot-state ${m.onTarget ? 'tgt' : ''}`} key={m.label}>
      <b>{m.label}</b>
      {m.stacks !== undefined && m.stacks > 1 && <i>×{m.stacks}</i>}
      {m.value !== undefined && <i>{k1(m.value)}</i>}
      {m.leftMs !== undefined && <em>{(m.leftMs / 1000).toFixed(1)} s left</em>}
    </span>
  );
  return (
    <div className="rot-tip" role="tooltip" style={tipStyle(rect, 280)}>
      <strong>After {MOVE_LABEL[after] ?? after}</strong>
      {states.length === 0 && <span className="rot-sum">Nothing tracked is up.</span>}
      {mine.length > 0 && <span className="rot-states"><span className="rot-sub">You</span>{mine.map(row)}</span>}
      {theirs.length > 0 && <span className="rot-states"><span className="rot-sub">Target</span>{theirs.map(row)}</span>}
    </div>
  );
}

function SkillTip({ rect, id, dmg, skills, stats, damage }: { rect: DOMRect; id: string; dmg?: string; skills: Record<string, SkillInfo>; stats: Record<Stat, number>; damage: DamageMap }) {
  const s = skills[id];
  const d = damage.get(dmg ?? id);
  const label = MOVE_LABEL[id] ?? id;
  const style = tipStyle(rect, 340);
  return (
    <div className="rot-tip" role="tooltip" style={style}>
      <strong>{label}</strong>{s?.level ? <em> Lv {s.level}</em> : null}
      {d && d.share > 0 && (
        <span className="rot-dmg">{(100 * d.share).toFixed(1)}% of your damage{d.perCast ? ` · ~${d.perCast.toLocaleString('en-US')} a cast` : ''}</span>
      )}
      {s?.summary && <span className="rot-sum">{s.summary}</span>}
      {s && s.scalings.length > 0 && (
        <span className="rot-scales">
          {s.scalings.map((sc, i) => {
            const total = sc.stats.reduce((a, k) => a + (stats[k] ?? 0), 0);
            const value = (sc.per * total) / sc.every;
            return (
              <span className="rot-scale" key={i} style={{ borderColor: STAT_COLOR[sc.stats[0]], color: STAT_COLOR[sc.stats[0]] }}>
                {sc.text} · {sc.stats.map((k) => `${k} ${stats[k] ?? 0}`).join(' + ')} → {value >= 0 ? '+' : ''}{Math.round(value)}%
              </span>
            );
          })}
        </span>
      )}
      {s?.desc && <span className="rot-desc">{s.desc}</span>}
      {!s && id === 'Attack' && <span className="rot-sum">Normal attacks between skills.</span>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="rot-section"><h4>{title}</h4>{children}</section>;
}

/**
 * A combo as icons and arrows; under each step its share of the combo's
 * damage, from each skill's average damage a cast in the sim's fights. The
 * same skill cast several times in a row is one tile with a ×N badge (the
 * project owner, 2026-10-01: saves width), its share the run's total. What a
 * step sets off by itself (Haunting Slice's Scythe Reap) follows it as an AUTO
 * tile; hovering an arrow shows the buffs, combo states and target debuffs
 * after the step before it, from one of the sim's fights.
 */
function Chain({ steps, marks, skills, stats, loop, share }: { steps: string[]; marks?: Mark[]; skills: Record<string, SkillInfo>; stats: Record<Stat, number>; loop?: boolean; share?: number }) {
  const damage = useContext(DamageCtx);
  const setHover = useContext(HoverCtx);
  const perCast = (id: string, auto?: boolean) => damage.get(auto ? autoKey(damage, id) : id)?.perCast ?? 0;
  type Run = { id: string; n: number; dmg: number; auto?: boolean; mark?: Mark };
  const runs: Run[] = [];
  steps.forEach((id, i) => {
    const mark = marks?.[i];
    const last = runs[runs.length - 1];
    if (last && !last.auto && last.id === id) { last.n++; last.dmg += perCast(id); last.mark = mark; } else runs.push({ id, n: 1, dmg: perCast(id), mark });
    // Autocasts get their own tiles after the step, folded like the steps; the arrow after them shows this step's states.
    for (const p of mark?.procs ?? []) {
      const prev = runs[runs.length - 1];
      if (prev.auto && prev.id === p) { prev.n++; prev.dmg += perCast(p, true); prev.mark = mark; } else runs.push({ id: p, n: 1, dmg: perCast(p, true), auto: true, mark });
    }
  });
  // Each step's share of the combo's damage; the % says enough, no totals (the project owner, 2026-10-02).
  const total = runs.reduce((a, r) => a + r.dmg, 0);
  const arrow = (after: Run, glyph: string, title?: string) => {
    if (!after.mark) return <span className="rot-arrow" title={title}>{glyph}</span>;
    const states = after.mark.states;
    const show = (e: React.SyntheticEvent<HTMLElement>) => setHover({ rect: e.currentTarget.getBoundingClientRect(), states, after: after.id });
    return (
      <span className="rot-arrow live" tabIndex={0} aria-label={`What is up after ${after.id}`}
        onMouseEnter={show} onFocus={show} onMouseLeave={() => setHover(null)} onBlur={() => setHover(null)}>
        {glyph}{states.length > 0 && <sup>{states.length}</sup>}
      </span>
    );
  };
  // Centered; a core loop sits on a card with its share of loops as a label in the top-left corner (the project owner, 2026-10-02).
  return (
    <div className={`rot-combo${share !== undefined ? ' card' : ''}`}>
    {share !== undefined && <span className="rot-loop-share">{Math.round(share * 100)}% of loops</span>}
    <div className="rot-chain">
      {runs.map((r, i) => (
        <span className="rot-step" key={`${r.id}-${i}`}>
          {i > 0 && arrow(runs[i - 1], r.auto ? '⇢' : '→')}
          <SkillTile id={r.id} skills={skills} stats={stats} part={total > 0 ? r.dmg / total : null} count={r.n} auto={r.auto} />
        </span>
      ))}
      {loop && runs.length > 0 && arrow(runs[runs.length - 1], '↻', 'then again')}
    </div>
    </div>
  );
}

function SkillTile({ id, skills, part, count, auto, badge }: { id: string; skills: Record<string, SkillInfo>; stats?: Record<Stat, number>; part?: number | null; count?: number; auto?: boolean; badge?: string }) {
  const s = skills[id];
  const setHover = useContext(HoverCtx);
  const [broken, setBroken] = useState(false);
  const label = MOVE_LABEL[id] ?? id;
  const initials = label.split(/\s+/).map((w) => w[0]).join('').slice(0, 3);
  const damage = useContext(DamageCtx);
  const show = (e: React.SyntheticEvent<HTMLElement>) => setHover({ id, dmg: auto ? autoKey(damage, id) : undefined, rect: e.currentTarget.getBoundingClientRect() });
  return (
    <span className="rot-cell">
      <span className={`rot-tile${auto ? ' auto' : ''}`} tabIndex={0} aria-label={label}
        onMouseEnter={show} onFocus={show} onMouseLeave={() => setHover(null)} onBlur={() => setHover(null)}>
        {s?.icon && !broken
          ? <img src={`./images/skills/${s.icon}.png`} alt="" onError={() => setBroken(true)} />
          : <span className="rot-ph">{initials}</span>}
        {auto && <span className="rot-badge" title="Cast by itself: set off by the step before it">AUTO</span>}
        {badge && <span className="rot-badge">{badge}</span>}
        {count !== undefined && count > 1 && <span className="rot-count" title={`${count} times in a row`}>×{count}</span>}
      </span>
      <span className="rot-cap">{label.replace(/ \(autocast\)$/, '*')}</span>
      {/* In a chain the line is always there (empty without a number), so every cell is the same height. */}
      {part !== undefined && <span className={`rot-part ${part !== null && part >= 0.2 ? 'big' : ''}`}>{part !== null ? `${Math.round(part * 100)}%` : ''}</span>}
    </span>
  );
}
