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
interface Rotation {
  opener: string[];
  cycles: { steps: string[]; share: number }[];
  fillers: { id: string; perLoop: number }[];
  roles: { role: string; share: number }[];
  /** Every damaging action: share of all damage, and average damage per cast. */
  damage: { id: string; share: number; perCast: number | null }[];
  prep: string[];
  dps: number;
}
interface ClassRotations {
  build: string; note: string; profileName: string;
  allround: Rotation & { vs: string };
  dummy: Rotation & { seconds: number };
  buffs: { skill: string; icon: string; dpsGain: number | null; required?: boolean }[];
  skills: Record<string, SkillInfo>;
}
interface RotationFile { builtAt: string; classes: Record<string, ClassRotations> }

/** The tile being hovered and where it sits: the overlay draws one floating tooltip for it (a tooltip inside the scrolling list gets clipped). */
interface Hover { id: string; rect: DOMRect }
const HoverCtx = createContext<(h: Hover | null) => void>(() => {});
/** The rotation's damage by action, for the combo breakdowns and the tooltip. */
type DamageMap = Map<string, { share: number; perCast: number | null }>;
const DamageCtx = createContext<DamageMap>(new Map());
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
  const cls = picked ?? (className && file?.classes[className] ? className : classes[0] ?? null);
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
            <select value={cls ?? ''} onChange={(e) => setPicked(e.target.value)} style={{ width: 160 }}>
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
              {className && className !== cls && (
                <p className="rot-note">Your build is {className}; showing {cls}.</p>
              )}
              <p className="rot-note">
                {tab === 'allround'
                  ? <>Played by the {data.note} over the ten endgame areas; the loop is read off a long fight against {data.allround.vs}.</>
                  : <>The most damage on the training dummy over {data.dummy.seconds} s, on the same build.</>}
                {' '}{Math.round(rot.dps).toLocaleString('en-US')} DPS there.{' '}
                <a href={data.build} target="_blank" rel="noreferrer">Open that build</a>
              </p>

              <Section title="Before the pull">
                <div className="rot-buffs">
                  {data.buffs.map((b) => (
                    <div className="rot-buff" key={b.skill}>
                      <SkillTile id={b.skill} skills={data.skills} stats={stats} />
                      <span className={`rot-gain ${b.required ? 'req' : b.dpsGain ? '' : 'def'}`}>
                        {b.required ? 'required' : b.dpsGain ? `+${(100 * b.dpsGain).toFixed(1)}% DPS` : 'defensive'}
                      </span>
                    </div>
                  ))}
                </div>
                {rot.prep.length > 0 && <p className="rot-sub">Up at the pull here: {rot.prep.join(' · ')}</p>}
              </Section>

              <Section title="Opener">
                <Chain steps={rot.opener} skills={data.skills} stats={stats} />
              </Section>

              {rot.cycles.length > 0 && (
                <Section title="Core loop">
                  {rot.cycles.map((c, i) => (
                    <div className="rot-cycle" key={i}>
                      <span className="rot-share">{Math.round(c.share * 100)}% of loops</span>
                      <Chain steps={c.steps} skills={data.skills} stats={stats} loop />
                    </div>
                  ))}
                </Section>
              )}

              {rot.fillers.length > 0 && (
                <Section title="Fillers, per loop">
                  <div className="rot-chain">
                    {rot.fillers.map((x) => (
                      <div className="rot-filler" key={x.id}>
                        <SkillTile id={x.id} skills={data.skills} stats={stats} />
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
          <span>From the combat sim{file ? `, ${file.builtAt.slice(0, 10)}` : ''}. Hover a skill for what it does and how it scales on your stats.</span>
          <span>Esc to close</span>
        </div>
      </div>
      {hover && data && <SkillTip hover={hover} skills={data.skills} stats={stats} damage={damage} />}
    </div>
    </DamageCtx.Provider>
    </HoverCtx.Provider>
  );
}

/** The floating tooltip: below the tile, or above it near the bottom, kept inside the window. */
function SkillTip({ hover, skills, stats, damage }: { hover: Hover; skills: Record<string, SkillInfo>; stats: Record<Stat, number>; damage: DamageMap }) {
  const s = skills[hover.id];
  const d = damage.get(hover.id);
  const label = MOVE_LABEL[hover.id] ?? hover.id;
  const W = 340;
  const left = Math.max(8, Math.min(window.innerWidth - W - 8, hover.rect.left + hover.rect.width / 2 - W / 2));
  const below = hover.rect.bottom + 8;
  const style = below > window.innerHeight * 0.55
    ? { left, bottom: window.innerHeight - hover.rect.top + 8, width: W }
    : { left, top: below, width: W };
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
      {!s && hover.id === 'Attack' && <span className="rot-sum">Normal attacks between skills.</span>}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="rot-section"><h4>{title}</h4>{children}</section>;
}

/**
 * A combo as icons and arrows; under each step its share of the combo's
 * damage, from each skill's average damage a cast in the sim's fights.
 */
function Chain({ steps, skills, stats, loop }: { steps: string[]; skills: Record<string, SkillInfo>; stats: Record<Stat, number>; loop?: boolean }) {
  const damage = useContext(DamageCtx);
  const per = steps.map((id) => damage.get(id)?.perCast ?? 0);
  const total = per.reduce((a, b) => a + b, 0);
  return (
    <div className="rot-chain">
      {steps.map((id, i) => (
        <span className="rot-step" key={`${id}-${i}`}>
          {i > 0 && <span className="rot-arrow">→</span>}
          <SkillTile id={id} skills={skills} stats={stats} part={total > 0 ? per[i] / total : null} />
        </span>
      ))}
      {loop && <span className="rot-arrow" title="then again">↻</span>}
      {total > 0 && <span className="rot-total" title="The combo's damage: each step's average damage a cast, added up">≈ {k1(total)} a {loop ? 'loop' : 'pass'}</span>}
    </div>
  );
}

function SkillTile({ id, skills, part }: { id: string; skills: Record<string, SkillInfo>; stats?: Record<Stat, number>; part?: number | null }) {
  const s = skills[id];
  const setHover = useContext(HoverCtx);
  const [broken, setBroken] = useState(false);
  const label = MOVE_LABEL[id] ?? id;
  const initials = label.split(/\s+/).map((w) => w[0]).join('').slice(0, 3);
  const show = (e: React.SyntheticEvent<HTMLElement>) => setHover({ id, rect: e.currentTarget.getBoundingClientRect() });
  return (
    <span className="rot-cell">
      <span className="rot-tile" tabIndex={0} aria-label={label}
        onMouseEnter={show} onFocus={show} onMouseLeave={() => setHover(null)} onBlur={() => setHover(null)}>
        {s?.icon && !broken
          ? <img src={`./images/skills/${s.icon}.png`} alt="" onError={() => setBroken(true)} />
          : <span className="rot-ph">{initials}</span>}
      </span>
      <span className="rot-cap">{label.replace(/ \(autocast\)$/, '*')}</span>
      {part !== undefined && part !== null && <span className={`rot-part ${part >= 0.2 ? 'big' : ''}`}>{Math.round(part * 100)}%</span>}
    </span>
  );
}
