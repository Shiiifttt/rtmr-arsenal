import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Build } from '@sim';
import { encodeBuild } from '../share';
import { PierceChart } from './PierceChart';

/**
 * Fight the current build in the combat sim (../combat). Dev server only.
 *
 * The page sends the build as its share payload to the dev server's
 * /__combat/run, which runs the sim as a node process -- the same program
 * as `npm run sim` -- and hands back its JSON. Nothing here is in a built
 * site: App mounts this only under import.meta.env.DEV.
 */

interface ActionRow { id: string; role: string; uses: number; damage: number; share: number; crit: number; miss: number }
interface Result {
  target: {
    name: string; level: number; hp: number; size: string; race: string; element: string;
    boss: boolean; dummy: boolean; def: number; mdef: number; notes: string[];
  };
  iterations: number;
  wins: number; losses: number; stalemates: number;
  stalls: Record<string, number>;
  winRate: number;
  ttk: { mean: number; p10: number; p50: number; p90: number } | null;
  dps: number; dtps: number; healed: number;
  deaths: Record<string, number>;
  actions: ActionRow[];
  sources: { id: string; hits: number; avoided: number; damage: number }[];
  log: string[] | null;
  analysis: {
    roles: { role: string; damage: number; share: number }[];
    survival: {
      score: number; label: string; survived: number; lowestHp: number;
      timeToDie: number | null; sustain: number; avoided: number;
    } | null;
    pierce: { def: number; pen: number; pierce: number; through: number; lostDps: number; lostShare: number } | null;
    prep: string[];
    read: { kind: 'setup' | 'damage' | 'rotation' | 'survival' | 'pierce' | 'pointer'; text: string }[];
  };
  msPerFight: number;
}
interface Reply {
  fighter: {
    maxHp: number; maxSp: number; aspd: number; hit: number; flee: number; critRate: number;
    notes: string[];
  };
  /** Every monster being fought, in order; `results` fills in as they finish. */
  targets: string[];
  results: Result[];
}

const TARGETS = [
  { value: 'dummy', label: 'Training dummy (30s DPS test)' },
  { value: 'rachel_ss', label: 'Rachel SS (every monster)' },
  { value: 'jorm', label: "Jormungand's Lair (every monster)" },
  { value: 'gorge', label: 'Dimensional Gorge distortion (every monster)' },
  { value: 'thanatos', label: 'Thanatos Paradise distortion (every monster)' },
  { value: 'freya', label: 'Freya distortion (every monster)' },
  { value: 'tomb', label: 'Tomb of Kings (every monster)' },
  { value: 'guild', label: 'Guild dungeon (every monster)' },
];

const SETTINGS_KEY = 'rtmr.combat.v1';
interface Settings {
  vs: string; custom: string; iter: string; hp: string; sp: string; aspd: string; healing: boolean; swap: boolean; log: boolean;
}
const DEFAULTS: Settings = {
  vs: 'dummy', custom: '', iter: '100', hp: '', sp: '', aspd: '', healing: false, swap: false, log: false,
};

function loadSettings(): Settings {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') }; }
  catch { return DEFAULTS; }
}

const n0 = (x: number) => Math.round(x).toLocaleString('en-US');
const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export default function CombatPanel({ build, onClose }: { build: Build; onClose: () => void }) {
  const [s, setS] = useState<Settings>(loadSettings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reply, setReply] = useState<Reply | null>(null);

  useEffect(() => {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch { /* not worth failing over */ }
  }, [s]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => setS((p) => ({ ...p, [k]: v }));

  // Closing the panel mid-run drops the request, and the dev server stops the fights.
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  /**
   * The dev server streams the run: a "start" line naming the monsters, a
   * "result" line as each one finishes, then "done" -- or an "error" line.
   * Cards appear as their results land, and the count shows how far along it is.
   */
  async function runSim() {
    setBusy(true); setError(null); setReply(null);
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    try {
      const vs = s.vs === 'custom' ? s.custom.trim() : s.vs;
      const res = await fetch('/__combat/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctl.signal,
        body: JSON.stringify({
          build: await encodeBuild(build), vs, iter: s.iter, hp: s.hp, sp: s.sp, aspd: s.aspd,
          healing: s.healing,
          swap: s.swap,
          log: s.log,
        }),
      });
      if (!res.ok || !res.body) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffered = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffered += value;
        const lines = buffered.split('\n');
        buffered = lines.pop() ?? '';
        for (const text of lines) {
          if (!text.trim()) continue;
          const msg = JSON.parse(text);
          if (msg.type === 'start') setReply({ fighter: msg.fighter, targets: msg.targets, results: [] });
          else if (msg.type === 'result') setReply((r) => r && { ...r, results: [...r.results, msg.result] });
          else if (msg.type === 'error') throw new Error(msg.error);
        }
      }
    } catch (e) {
      if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (abort.current === ctl) setBusy(false);
    }
  }

  const notSatsujin = build.className !== 'Satsujin';

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="picker combat" role="dialog" aria-modal="true" aria-label="Combat sim">
        <div className="picker-head">
          <h3>Combat sim</h3>
          <span className="focus-sub">dev only</span>
          <div className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>

        <div className="combat-form">
          <label>
            <span>Fight</span>
            <select value={s.vs} onChange={(e) => set('vs', e.target.value)}>
              {TARGETS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              <option value="custom">A monster by name or id…</option>
            </select>
          </label>
          {s.vs === 'custom' && (
            <label>
              <span>Monster</span>
              <input value={s.custom} placeholder="Tortured Maiden" onChange={(e) => set('custom', e.target.value)} />
            </label>
          )}
          <label>
            <span>Fights each</span>
            <input type="number" min={1} max={2000} value={s.iter} onChange={(e) => set('iter', e.target.value)} />
          </label>
          <label title="Read off the character window, without Moonlight Stance. Empty: modelled.">
            <span>Max HP</span>
            <input type="number" min={0} placeholder="model" value={s.hp} onChange={(e) => set('hp', e.target.value)} />
          </label>
          <label title="Read off the character window. Empty: modelled (a guess).">
            <span>Max SP</span>
            <input type="number" min={0} placeholder="model" value={s.sp} onChange={(e) => set('sp', e.target.value)} />
          </label>
          <label title="Read off the character window. Empty: the build's ASPD limit (180, +1 per 40 AGI and per ASPD Limit on gear, up to 190).">
            <span>ASPD</span>
            <input type="number" min={0} max={199} placeholder="limit" value={s.aspd} onChange={(e) => set('aspd', e.target.value)} />
          </label>
          {/* Kept together so none of them wraps onto its own row. */}
          <div className="combat-go">
            <label className="check" title={'Also carry White Potions, Blue Potions and Yggdrasil '
              + 'Berries. Off by default: nobody carries hundreds, and they are expensive. Green '
              + 'Potions are always carried, and on a boss the free Kafra Elixirs (2 a life, '
              + 'more with an Elixir Badge).'}>
              <input type="checkbox" checked={s.healing} onChange={(e) => set('healing', e.target.checked)} />
              Healing items
            </label>
            <label className="check" title={'Come prepared with spares: for each monster, the armour element '
              + 'that does best against it (from the threat list) and your racial damage and resistance cards '
              + 'aimed at its race. What changed shows under each result.'}>
              <input type="checkbox" checked={s.swap} onChange={(e) => set('swap', e.target.checked)} />
              Smart swap
            </label>
            <label className="check" title="Include the first fight's combat log">
              <input type="checkbox" checked={s.log} onChange={(e) => set('log', e.target.checked)} />
              Log
            </label>
            <button className="combat-run" disabled={busy || (s.vs === 'custom' && !s.custom.trim())}
              onClick={() => void runSim()}>
              Run
            </button>
          </div>
        </div>

        <div className="picker-list combat-results">
          {notSatsujin && (
            <p className="empty-note">
              Only a Satsujin kit exists so far: this {build.className ?? 'classless'} build
              is fought with Satsujin skills.
            </p>
          )}
          {error && <p className="combat-error">{error}</p>}
          {busy && !reply && <div className="combat-progress" role="status">Starting the sim…</div>}
          {reply && (
            <>
              <p className="combat-sheet">
                HP {n0(reply.fighter.maxHp)} · SP {n0(reply.fighter.maxSp)} · ASPD {reply.fighter.aspd}
                {' '}· HIT {reply.fighter.hit} · FLEE {reply.fighter.flee} · CRIT {reply.fighter.critRate}
              </p>
              {reply.results.map((r) => <ResultCard key={r.target.name} r={r} open={reply.targets.length === 1} />)}
              {busy && reply.results.length < reply.targets.length && (
                <div className="combat-progress" role="status">
                  <span>
                    Simulating {reply.results.length + 1} of {reply.targets.length}:{' '}
                    <b>{reply.targets[reply.results.length]}</b>…
                  </span>
                  <span className="combat-progress-track">
                    <span style={{ width: `${(reply.results.length / reply.targets.length) * 100}%` }} />
                  </span>
                </div>
              )}
              <details className="combat-notes">
                <summary>What the sim assumed</summary>
                <ul>{reply.fighter.notes.map((n) => <li key={n}>{n}</li>)}</ul>
              </details>
            </>
          )}
          {!reply && !error && !busy && (
            <p className="empty-note">
              Plays the build as a TAS against each monster, many seeds over. The
              monsters' skills are unverified guesses (combat/data/mob-skills.json).
            </p>
          )}
        </div>

        <div className="picker-foot">
          <span>Same program as <code>npm run sim</code> in combat/.</span>
          <span>Every skill at max level.</span>
        </div>
      </div>
    </div>
  );
}

/**
 * A fixed colour per role, so a role reads the same on every card. Ranking
 * the colours by share put auto-attacks in a purple next to the Moon
 * combo's, which the eye could not tell apart. Roles not named here (buffs,
 * upkeep) share the faint one.
 */
const ROLE_TINT: Record<string, string> = {
  // Satsujin
  'Moon combo': 'r0', Fillers: 'r1', Omamori: 'r2', 'Auto-attacks': 'r3',
  // Kingslayer
  Shield: 'r0', Counters: 'r2', Openers: 'r3', Reflect: 'r5', Finisher: 'r5', Dodges: 'r6',
};
const SPARE_TINTS = ['r0', 'r1', 'r2', 'r3', 'r5', 'r6'];

/**
 * Each role on a card its own colour: the named ones as above, any other
 * the first tint the card has not used yet, and only past those the faint one.
 */
function tintsFor(roles: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const role of roles) if (ROLE_TINT[role]) out.set(role, ROLE_TINT[role]);
  const used = new Set(out.values());
  for (const role of roles) {
    if (out.has(role)) continue;
    const free = SPARE_TINTS.find((t) => !used.has(t));
    out.set(role, free ?? 'r4');
    if (free) used.add(free);
  }
  return out;
}

/**
 * A label that opens a small popover on hover or keyboard focus. The detail
 * a card can do without at a glance -- the rotation, the DEF curve, what the
 * survivability score is made of -- lives in these.
 */
function Hover({ label, className, children }: {
  label: string; className: string; children: ReactNode;
}) {
  return (
    <span className={`combat-hover ${className}`} tabIndex={0}>
      {label}
      <span className="combat-pop" role="tooltip">{children}</span>
    </span>
  );
}

function ResultCard({ r, open }: { r: Result; open: boolean }) {
  const t = r.target;
  const verdict = t.dummy ? null : r.winRate >= 0.9 ? 'Beatable' : r.winRate >= 0.5 ? 'Risky' : 'Not yet';
  const tone = r.winRate >= 0.9 ? 'good' : r.winRate >= 0.5 ? 'warn' : 'bad';
  // One colour per role, shared by the bar and the table's action names.
  const tint = tintsFor([...new Set(r.actions.map((a) => a.role))]);
  const surv = r.analysis.survival;
  const survTone = !surv ? '' : surv.score >= 80 ? 'good' : surv.score >= 60 ? 'warn' : 'bad';
  const deaths = Object.entries(r.deaths).sort((a, b) => b[1] - a[1]);
  const stalls = Object.entries(r.stalls);
  const read = r.analysis.read;
  const lines = (kind: string) => read.filter((x) => x.kind === kind).map((x) => x.text).join(' ');
  const rotation = read.filter((x) => x.kind === 'rotation');
  const pointers = read.filter((x) => x.kind === 'pointer');
  const pierce = r.analysis.pierce;
  const endow = /Seven Winds: (\w+)/.exec(r.analysis.prep.join(' '))?.[1];
  return (
    // Collapsed unless it is the only monster fought: the head alone says
    // whether a card is worth opening.
    <details className="combat-result" open={open}>
      <summary className="combat-result-head">
        <strong>{t.name}</strong>
        <span className="focus-sub">
          Lv{t.level} {t.size} {t.race} {t.element}{t.boss ? ' · boss' : ''}
          {!t.dummy && ` · ${n0(t.hp)} HP · DEF ${t.def} · MDEF ${t.mdef}`}
        </span>
        <div className="spacer" />
        <span className="combat-head-dps">{n0(r.dps)} DPS</span>
        {(surv || verdict) && <div className="combat-badges">
        {surv && (
          <Hover className={`combat-verdict ${survTone}`} label={`Survivability ${surv.score} · ${surv.label}`}>
            <p>{lines('survival')}</p>
            <p className="combat-pop-note">
              0-100: half how often you live, a quarter the closest call (median lowest HP), a
              quarter how long you would last at the net damage intake (120s = full). For
              comparing builds, not a probability.
            </p>
          </Hover>
        )}
        {verdict && <span className={`combat-verdict ${tone}`}>{verdict} · {pct(r.winRate)}</span>}
        </div>}
      </summary>
      {r.analysis.roles.length > 0 && (
        <div className="combat-roles" aria-label="Damage by role">
          {r.analysis.roles.map((x) => (
            <span key={x.role} className={`combat-role ${tint.get(x.role)}`} style={{ flexGrow: x.share }}
              title={`${x.role}: ${n0(x.damage)} (${pct(x.share)})`}>
              {x.share >= 0.08 ? `${x.role} ${Math.round(x.share * 100)}%` : ''}
            </span>
          ))}
        </div>
      )}
      {/* The detail lives in hovers; the card itself stays a glance. */}
      <div className="combat-chips">
        {endow && (
          <Hover className="combat-chip" label={`${endow} endow`}>
            <p>Before the pull: {r.analysis.prep.join(', ')}.</p>
          </Hover>
        )}
        {rotation.length > 0 && (
          <Hover className="combat-chip" label="Rotation">
            {rotation.map((x) => <p key={x.text}>{x.text}</p>)}
          </Hover>
        )}
        {pierce && (
          <Hover className="combat-chip" label={`DEF ${pierce.def} · ${pct(pierce.through)} through`}>
            <p>{lines('pierce')}</p>
            {/* The arsenal's own penetration hover, judged against this one monster. */}
            <PierceChart kind="def" pen={pierce.pen}
              targets={[{ label: t.name, value: t.def, name: t.name, level: t.level }]} />
          </Hover>
        )}
      </div>
      {pointers.length > 0 && (
        <ul className="combat-read">
          {pointers.map((x) => <li key={x.text}>{x.text}</li>)}
        </ul>
      )}
      <div className="combat-figures">
        {r.ttk && <span>kill in <b>{r.ttk.p50.toFixed(1)}s</b> (p10 {r.ttk.p10.toFixed(1)}, p90 {r.ttk.p90.toFixed(1)})</span>}
        {!t.dummy && <span><b>{n0(r.dtps)}</b> taken/s</span>}
        {!t.dummy && <span>won {r.wins} · lost {r.losses} · stalemate {r.stalemates} of {r.iterations}</span>}
      </div>
      {(deaths.length > 0 || stalls.length > 0) && (
        <div className="combat-why">
          {deaths.length > 0 && <>Killed by {deaths.map(([k, v]) => `${k} ×${v}`).join(', ')}. </>}
          {stalls.length > 0 && <>Stalemates: {stalls.map(([k, v]) => `${k} ×${v}`).join(', ')}.</>}
        </div>
      )}
      <table className="combat-table">
        <thead><tr><th>Action</th><th>Uses</th><th>Damage</th><th>Share</th><th>Crit</th><th>Miss</th></tr></thead>
        <tbody>
          {r.actions.filter((a) => a.damage > 0).map((a) => (
            <tr key={a.id}>
              <td className={`combat-name ${tint.get(a.role) ?? ''}`} title={a.role}>{a.id}</td>
              <td>{a.uses.toFixed(1)}</td><td>{n0(a.damage)}</td>
              <td>{pct(a.share)}</td><td>{a.crit ? pct(a.crit) : '–'}</td><td>{a.miss ? pct(a.miss) : '–'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.sources.length > 0 && (
        <table className="combat-table">
          <thead><tr><th>Taken from</th><th>Hits</th><th>Avoided</th><th>Damage</th></tr></thead>
          <tbody>
            {r.sources.map((x) => (
              <tr key={x.id}><td>{x.id}</td><td>{x.hits.toFixed(1)}</td><td>{x.avoided.toFixed(1)}</td><td>{n0(x.damage)}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {t.notes.length > 0 && <div className="combat-why">{t.notes.join(' · ')}</div>}
      {r.log && (
        <details className="combat-notes">
          <summary>First fight</summary>
          <pre className="combat-log">{r.log.join('\n')}</pre>
        </details>
      )}
    </details>
  );
}
