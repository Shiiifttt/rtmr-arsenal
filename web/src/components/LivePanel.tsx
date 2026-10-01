import { useEffect, useRef, useState } from 'react';
import type { Build, Dataset } from '@sim';
import { decodeBuild, encodeBuild } from '../share';
import { Icon } from './Icon';
import { tooltipProps } from './ItemTooltip';

/**
 * Watch a gear search (combat/tools/gear-search.ts) as it runs -- or start
 * one from the build being edited. Dev server only.
 *
 * Each search writes its status to combat/runs/live/<pid>.json a few times a
 * second (combat/src/live.ts); the dev server's /__combat/live hands back the
 * recent ones. This polls that and nothing more, so the search pays nothing
 * for being watched -- and polling stops while the tab is hidden.
 *
 * A search started here (POST /__combat/search) runs detached from the dev
 * server, so it outlives the tab; its result loads back into the editor.
 */

interface Score { value: number; win: number; loss: number; dps: number; killsPerHour?: number; deathsPerHour?: number; sitS?: number }
interface Worker { target: string | null; kind: string; fights: number; changes: { key: string; text: string; ids?: number[] }[] }
interface Run {
  pid: number; status: 'running' | 'done' | 'stopped'; startedAt: number; updatedAt: number;
  fights: number; fightsPerSec: number;
  profile?: string; className: string | null; vs: string[]; maps: string[]; scoreMode: string;
  phase: string; pass: number; group: string; groupAt: number; groups: number; tried: number; tag: string;
  score: Score | null; best: { label: string; gain: number } | null;
  build: { slots: { key: string; label: string; text: string; ids?: number[] }[]; stats: Record<string, number>; options: Record<string, unknown> };
  steps: { move: string; before: Score; after: Score; tried: number }[];
  workers: Worker[];
  /** The build found, as a share payload, once done. */
  result?: string | null;
}

const POLL_MS = 400;
/** No update for this long and a "running" search has died or hung. */
const STALE_MS = 5_000;
/** Fights a second, the last ~30 s, for the sparkline. */
const HISTORY = 75;

const n0 = (x: number) => Math.round(x).toLocaleString('en-US');
const pct = (x: number) => `${Math.round(x * 100)}%`;
const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60);
  return `${h ? `${h}:` : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`;
};

/** Running, done, or stopped: told to stop, or died (no update for STALE_MS). */
function runState(r: Run, now: number): 'running' | 'done' | 'stopped' {
  if (r.status !== 'running') return r.status;
  return now - r.updatedAt > STALE_MS ? 'stopped' : 'running';
}

/** The score in the search's own terms: kills and deaths an hour under rhythm scoring, else wins and DPS. */
function scoreText(s: Score): string {
  if (s.killsPerHour !== undefined) {
    return `${n0(s.killsPerHour)} kills/h · ${(s.deathsPerHour ?? 0).toFixed(1)} deaths/h`;
  }
  return `win ${pct(s.win)} · lost ${pct(s.loss)} · ${n0(s.dps)} DPS`;
}

export default function LivePanel({ dataset, build, onLoad, onClose }: {
  dataset: Dataset; build: Build; onLoad: (b: Build) => void; onClose: () => void;
}) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [now, setNow] = useState(Date.now());
  const [pick, setPick] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Per search, its fights a second over time.
  const history = useRef(new Map<number, number[]>());

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (stop) return;
      if (!document.hidden) {
        try {
          const res = await fetch('/__combat/live', { cache: 'no-store' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = await res.json() as { now: number; runs: Run[] };
          for (const r of body.runs) {
            const h = history.current.get(r.pid) ?? [];
            if (r.status === 'running') h.push(r.fightsPerSec);
            history.current.set(r.pid, h.slice(-HISTORY));
          }
          if (!stop) { setRuns(body.runs); setNow(body.now); setError(null); }
        } catch (e) {
          if (!stop) setError(e instanceof Error ? e.message : String(e));
        }
      }
      if (!stop) timer = setTimeout(poll, POLL_MS);
    };
    void poll();
    return () => { stop = true; clearTimeout(timer); };
  }, []);

  const run = runs.find((r) => r.pid === pick) ?? runs[0] ?? null;

  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="picker combat live" role="dialog" aria-modal="true" aria-label="Live search">
        <div className="picker-head">
          <h3>Live search</h3>
          <span className="focus-sub">dev only</span>
          {runs.length > 1 && (
            <select value={run?.pid ?? ''} onChange={(e) => setPick(Number(e.target.value))}>
              {runs.map((r) => (
                <option key={r.pid} value={r.pid}>
                  {r.profile ?? r.pid} · {runState(r, now)}
                </option>
              ))}
            </select>
          )}
          <div className="spacer" />
          <button onClick={onClose}>Close</button>
        </div>
        <StartForm build={build} open={!run} onStarted={setPick} />
        <div className="picker-list">
          {error && <p className="combat-error">{error}</p>}
          {pick !== null && !runs.some((r) => r.pid === pick) && (
            <div className="combat-progress" role="status">Starting search {pick}… (loading the data takes a few seconds)</div>
          )}
          {!run && !error && pick === null && (
            <p className="empty-note">
              No search has run in the last 10 minutes. Start one above, or in combat/
              (tools/gear-search.ts) -- it shows up here by itself.
            </p>
          )}
          {run && <RunView run={run} now={now} history={history.current.get(run.pid) ?? []} dataset={dataset} onLoad={onLoad} />}
        </div>
        <div className="picker-foot">
          <span>combat/runs/live/{run?.pid ?? '…'}.json, every 250 ms.</span>
          <span>--no-live turns it off.</span>
        </div>
      </div>
    </div>
  );
}

function RunView({ run, now, history, dataset, onLoad }: {
  run: Run; now: number; history: number[]; dataset: Dataset; onLoad: (b: Build) => void;
}) {
  const state = runState(run, now);
  const elapsed = (state === 'running' ? now : run.updatedAt) - run.startedAt;
  const [actionError, setActionError] = useState<string | null>(null);
  async function stop() {
    if (!confirm(`Stop search ${run.pid}? What it found so far is lost (only the log is kept).`)) return;
    const res = await fetch('/__combat/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pid: run.pid }) });
    if (!res.ok) setActionError((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
  }
  async function load() {
    const b = run.result ? await decodeBuild(run.result) : null;
    if (b) onLoad(b); else setActionError('could not read the result');
  }
  const where = run.maps.length ? run.maps.join(', ') : run.vs.join(', ');
  // How many workers have each slot under test right now.
  const testing = new Map<string, number>();
  for (const w of run.workers) for (const c of new Set(w.changes.map((x) => x.key))) testing.set(c, (testing.get(c) ?? 0) + 1);
  const busy = run.workers.filter((w) => w.kind !== 'idle').length;
  const stats = Object.entries(run.build.stats).filter(([k]) => ['str', 'agi', 'vit', 'int', 'dex', 'luk'].includes(k));

  return (
    <>
      <p className="combat-sheet">
        {run.profile} · {run.className ?? 'classless'} · {where} · {run.scoreMode} score
      </p>
      <div className="live-figures">
        <div className="live-big">
          <span className="live-num">{n0(run.fightsPerSec)}</span>
          <span className="live-unit">fights/s</span>
          <Sparkline values={history} />
        </div>
        <div className="live-facts">
          <span className={`live-state ${state}`}>{state}</span>
          <span><b>{clock(elapsed)}</b> elapsed</span>
          <span><b>{n0(run.fights)}</b> fights</span>
          <span><b>{busy}</b>/{run.workers.length} workers busy</span>
        </div>
        <div className="live-actions">
          {state === 'running' && <button onClick={() => void stop()}>Stop</button>}
          {state === 'done' && run.result && (
            <button className="combat-run" onClick={() => void load()}
              title="Replace the build being edited with the one this search found">Load into editor</button>
          )}
        </div>
      </div>
      {actionError && <p className="combat-error">{actionError}</p>}
      <div className="live-phase">
        <b>{run.phase}</b>
        {run.tag && <> · {run.tag}</>}
        {run.pass > 0 && <> · pass {run.pass}</>}
        {run.group && <> · {run.group}</>}
        {run.groups > 0 && <span className="focus-sub"> ({run.groupAt} of {run.groups})</span>}
        {run.tried > 0 && <span className="focus-sub"> · {n0(run.tried)} candidates</span>}
      </div>
      {run.score && (
        <div className="live-score">
          <span>Current build: <b>{scoreText(run.score)}</b></span>
          {run.best && (
            <span className="focus-sub">
              last screen's best: {run.best.label || '–'} ({run.best.gain >= 0 ? '+' : ''}{run.best.gain.toFixed(3)})
            </span>
          )}
        </div>
      )}

      <div className="live-cols">
        <section>
          <h4>Build</h4>
          <ul className="live-slots">
            {run.build.slots.map((s) => (
              <li key={s.key} className={testing.has(s.key) ? 'testing' : ''}>
                <span className="live-slot">{s.label}</span>
                {/* Keyed on the text: a kept change flashes as it lands. */}
                <Icons ids={s.ids} dataset={dataset} key={`i:${s.text}`} />
                <span key={s.text} className="live-item flash">{s.text}</span>
                {testing.has(s.key) && <span className="live-count" title="Workers trying something here">×{testing.get(s.key)}</span>}
              </li>
            ))}
            <li className={testing.has('stats') ? 'testing' : ''}>
              <span className="live-slot">Stats</span>
              <span key={stats.map(([, v]) => v).join()} className="live-item flash">
                {stats.map(([k, v]) => `${k.toUpperCase()} ${v}`).join(' · ')}
              </span>
            </li>
          </ul>
        </section>
        <section>
          <h4>Workers</h4>
          <ol className="live-workers">
            {run.workers.map((w, i) => (
              <li key={i} className={w.kind}>
                <span className="live-kind">{w.kind}</span>
                <span className="live-target">{w.target ?? (w.kind === 'idle' ? '' : '…')}</span>
                <Icons ids={w.changes.flatMap((c) => c.ids ?? [])} dataset={dataset} key={`i:${w.changes.map((c) => c.text).join('|')}`} />
                <span key={w.changes.map((c) => c.text).join('|')} className="live-change flash">
                  {w.kind === 'idle' ? '' : w.changes.length ? w.changes.map((c) => c.text).join(' + ') : 'the build as it is'}
                </span>
              </li>
            ))}
          </ol>
        </section>
      </div>

      {run.steps.length > 0 && (
        <section className="live-steps">
          <h4>Kept changes</h4>
          <table className="combat-table">
            <thead><tr><th>Change</th><th>Tried</th><th>Before</th><th>After</th></tr></thead>
            <tbody>
              {[...run.steps].reverse().map((s, i) => (
                <tr key={`${run.steps.length - i}:${s.move}`}>
                  <td>{s.move}</td><td>{n0(s.tried)}</td>
                  <td>{scoreText(s.before)}</td><td>{scoreText(s.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </>
  );
}

const AREAS = [
  { value: 'tomb', label: 'Tomb of Kings' },
  { value: 'rachel_ss', label: 'Rachel SS' },
  { value: 'jorm', label: "Jormungand's Lair" },
  { value: 'gorge', label: 'Dimensional Gorge distortion' },
  { value: 'thanatos', label: 'Thanatos Paradise distortion' },
  { value: 'freya', label: 'Freya distortion' },
  { value: 'guild', label: 'Guild dungeon' },
];

const SEARCH_KEY = 'rtmr.search.v1';
interface SearchSettings {
  vs: string; custom: string; score: string; profile: string; screen: string; confirm: string; passes: string;
  only: string; census: boolean; perTarget: boolean; extra: string;
}
const SEARCH_DEFAULTS: SearchSettings = {
  vs: 'tomb', custom: '', score: 'rhythm', profile: '', screen: '60', confirm: '400', passes: '3',
  only: '', census: true, perTarget: false, extra: '',
};
function loadSearch(): SearchSettings {
  try { return { ...SEARCH_DEFAULTS, ...JSON.parse(localStorage.getItem(SEARCH_KEY) ?? '{}') }; }
  catch { return SEARCH_DEFAULTS; }
}

/**
 * Start a search from the build being edited. The profile only lends its
 * readings (measured HP, ATK offsets...) and rotation; the gear is the page's.
 * Profiles are listed for the build's class first (by file name).
 */
function StartForm({ build, open, onStarted }: { build: Build; open: boolean; onStarted: (pid: number) => void }) {
  const [s, setS] = useState<SearchSettings>(loadSearch);
  const [profiles, setProfiles] = useState<{ file: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const set = <K extends keyof SearchSettings>(k: K, v: SearchSettings[K]) => setS((p) => ({ ...p, [k]: v }));

  useEffect(() => {
    try { localStorage.setItem(SEARCH_KEY, JSON.stringify(s)); } catch { /* not worth failing over */ }
  }, [s]);

  const cls = (build.className ?? '').toLowerCase();
  const mine = profiles.filter((p) => cls && p.file.toLowerCase().startsWith(cls));
  useEffect(() => {
    fetch('/__combat/profiles').then((r) => r.json()).then(setProfiles).catch(() => setProfiles([]));
  }, []);
  // A profile of another class would bring the wrong rotation: the newest of this class instead.
  useEffect(() => {
    if (!profiles.length) return;
    if (s.profile === '-' || mine.some((p) => p.file === s.profile)) return;
    set('profile', mine[0]?.file ?? '-');
  }, [profiles, cls]);

  async function start() {
    setBusy(true); setError(null); setNote(null);
    try {
      const vs = s.vs === 'custom' ? s.custom.trim() : s.vs;
      const res = await fetch('/__combat/search', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          build: await encodeBuild(build), vs, score: s.score, profile: s.profile === '-' ? '' : s.profile,
          screen: s.screen, confirm: s.confirm, passes: s.passes, only: s.only.replace(/\s+/g, ''),
          census: s.census, perTarget: s.perTarget, extra: s.extra.trim(),
          name: `${build.className ?? 'Build'} from the web view, ${vs}`,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setNote(`Search ${body.pid}: output in ${body.log}, result in ${body.out}.`);
      onStarted(body.pid);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="live-start" open={open}>
      <summary>New search from this build</summary>
      <div className="combat-form">
        <label>
          <span>Fight</span>
          <select value={s.vs} onChange={(e) => set('vs', e.target.value)}>
            {AREAS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
            <option value="custom">Monsters or groups by name…</option>
          </select>
        </label>
        {s.vs === 'custom' && (
          <label>
            <span>Monsters</span>
            <input value={s.custom} placeholder="tomb,jorm or Heartless" onChange={(e) => set('custom', e.target.value)} />
          </label>
        )}
        <label title="Rhythm: kills an hour fighting, sitting and pulling again, weighed by spawns. Fight: wins, then DPS. Safe: not losing first.">
          <span>Score</span>
          <select value={s.score} onChange={(e) => set('score', e.target.value)}>
            <option value="rhythm">Kills/h (farming)</option>
            <option value="fight">Wins, then DPS</option>
            <option value="safe">Safe first</option>
          </select>
        </label>
        <label title="Readings and rotation come from this profile; the gear is the build being edited.">
          <span>Readings & rotation</span>
          <select value={s.profile} onChange={(e) => set('profile', e.target.value)}>
            <option value="-">The kit's defaults</option>
            {mine.map((p) => <option key={p.file} value={p.file} title={p.name}>{p.file.replace(/\.json$/, '')}</option>)}
            {profiles.filter((p) => !mine.includes(p)).length > 0 && (
              <optgroup label="Other classes">
                {profiles.filter((p) => !mine.includes(p)).map((p) => (
                  <option key={p.file} value={p.file} title={p.name}>{p.file.replace(/\.json$/, '')}</option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        <label title="Fights per candidate in the first look (a precision; quiet monsters get fewer)">
          <span>Screen</span>
          <input type="number" min={1} value={s.screen} onChange={(e) => set('screen', e.target.value)} />
        </label>
        <label title="Fights for the finalists, on fresh seeds, before a change is kept">
          <span>Confirm</span>
          <input type="number" min={1} value={s.confirm} onChange={(e) => set('confirm', e.target.value)} />
        </label>
        <label title="Times through every slot, at most (it stops once nothing helps)">
          <span>Passes</span>
          <input type="number" min={1} max={99} value={s.passes} onChange={(e) => set('passes', e.target.value)} />
        </label>
        <label title="Only these: slot keys (garment, upper, weapon...), stats, rotation, order, sets, shadow, rolls. Empty: everything.">
          <span>Only</span>
          <input value={s.only} placeholder="everything" onChange={(e) => set('only', e.target.value)} />
        </label>
        <label className="live-extra" title={'More gear-search flags, e.g. --lock offhand --exclude "Dark Illusion Card" --no-mvp. '
          + 'Only the search\'s own flags are accepted.'}>
          <span>More flags</span>
          <input value={s.extra} placeholder='--lock offhand --no-mvp' onChange={(e) => set('extra', e.target.value)} />
        </label>
        <div className="combat-go">
          <label className="check" title="First try every shadow piece and card alone, and drop what adds nothing (slower start, faster passes)">
            <input type="checkbox" checked={s.census} onChange={(e) => set('census', e.target.checked)} />
            Census
          </label>
          <label className="check" title="After the shared build, the swaps worth making for each monster">
            <input type="checkbox" checked={s.perTarget} onChange={(e) => set('perTarget', e.target.checked)} />
            Per-monster swaps
          </label>
          <button className="combat-run" disabled={busy || (s.vs === 'custom' && !s.custom.trim())} onClick={() => void start()}>
            Start search
          </button>
        </div>
      </div>
      {error && <p className="combat-error live-start-msg">{error}</p>}
      {note && <p className="combat-why live-start-msg">{note}</p>}
    </details>
  );
}

/** A piece's icon, with the arsenal's own hover tooltip. */
function Icons({ ids, dataset }: { ids?: number[]; dataset: Dataset }) {
  const items = (ids ?? []).map((id) => dataset.items.get(id)).filter((x) => !!x);
  if (!items.length) return null;
  return (
    <span className="live-icons flash">
      {items.map((item, i) => <span key={i} {...tooltipProps({ kind: 'item', item })}><Icon item={item} /></span>)}
    </span>
  );
}

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 160; const h = 28;
  const top = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i / (HISTORY - 1)) * w},${h - (v / top) * (h - 2) - 1}`).join(' ');
  return (
    <svg className="live-spark" width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
