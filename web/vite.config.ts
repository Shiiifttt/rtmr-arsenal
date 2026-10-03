import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn } from 'node:child_process';
import {
  closeSync, createReadStream, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cp } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The package is ESM, so __dirname does not exist here.
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SERVED = ['data', 'images', 'recognition'];

const TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

/**
 * Serve the generated dataset straight out of the repo.
 *
 * The data and images live next to the app rather than inside it, so they
 * are not duplicated into the source tree just to be reachable. In dev a
 * middleware streams them; on build they are copied into dist so the output
 * is a self-contained static folder.
 */
function datasetPlugin(): Plugin {
  return {
    name: 'rtmr-dataset',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0];
        const top = url.split('/')[1];
        if (!SERVED.includes(top)) return next();

        // Keep the request inside the served folders.
        const path = normalize(join(ROOT, decodeURIComponent(url)));
        if (!SERVED.some((d) => path.startsWith(join(ROOT, d)))) return next();
        if (!existsSync(path) || !statSync(path).isFile()) return next();

        res.setHeader('Content-Type', TYPES[extname(path)] ?? 'application/octet-stream');
        createReadStream(path).pipe(res);
      });
    },
    async closeBundle() {
      for (const dir of SERVED) {
        const from = join(ROOT, dir);
        if (existsSync(from)) {
          await cp(from, join(HERE, 'dist', dir), { recursive: true });
        }
      }
    },
  };
}

/** Arguments the combat panel may send, and the shape each must have. */
const COMBAT_ARGS: Record<string, RegExp> = {
  build: /^[A-Za-z0-9_-]{1,20000}$/,
  vs: /^[A-Za-z0-9 _',.-]{1,200}$/,
  iter: /^\d{1,4}$/,
  hp: /^\d{1,6}$/,
  sp: /^\d{1,6}$/,
  aspd: /^\d{1,3}$/,
  policy: /^(tas|priority)$/,
  items: /^[A-Za-z0-9 ',-]{1,300}$/,
  healing: /^(true|false)$/,
  swap: /^(true|false)$/,
  // A profile in combat/profiles by name, for its rotation and ASPD model (the at-a-glance window's
  // rotation pick: a Night Raven build plays its own build's rotation). Checked to exist below.
  profile: /^[a-z0-9-]{1,60}$/,
};

/** A small JSON body, or null. */
function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((done) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 100_000) req.destroy(); });
    req.on('end', () => { try { done(JSON.parse(raw)); } catch { done(null); } });
    req.on('error', () => done(null));
  });
}
function json(res: ServerResponse, code: number, body: unknown) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/**
 * The gear-search flags the Live panel's "more flags" field may pass (see
 * combat/tools/gear-search.ts). Anything else is refused: the field is for
 * the search's own options, not for running something else.
 */
const SEARCH_FLAGS = new Set([
  'lock', 'time', 'set', 'fix', 'exclude', 'keep-stats', 'slot-items', 'lock-cards', 'fix-refine', 'refine-cap',
  'penalty', 'mvp-penalty', 'max-refine', 'swap-cost', 'swap-slots', 'no-pairs', 'healing', 'allow-ss', 'no-race',
  'no-stats', 'workers', 'shadow-top', 'rolls', 'max-rolls', 'min-hp', 'flat', 'accept-z', 'confirm-more', 'cheapen',
  'mid-rolls', 'no-mvp', 'mvp-max-level', 'no-mvp-targets', 'death-weight', 'stall-weight', 'hp-weight', 'per-hour',
  'all-roll-stats', 'verbose', 'policy', 'objective', 'map',
]);
const SEARCH_VALUE = /^[A-Za-z0-9 _.,=+:;|'[\]/-]{1,300}$/;

/** "--lock offhand --exclude "Dark Illusion Card" --flat" -> argv, or an error. */
function searchExtra(text: string): string[] | string {
  const out: string[] = [];
  for (const m of text.matchAll(/"([^"]*)"|(\S+)/g)) {
    const tok = m[1] ?? m[2];
    if (m[2]?.startsWith('--')) {
      if (!SEARCH_FLAGS.has(m[2].slice(2))) return `not a flag the panel passes: ${m[2]}`;
    } else if (!out.length || !SEARCH_VALUE.test(tok)) return `bad value: ${tok}`;
    out.push(tok);
  }
  return out;
}

const SEARCH_ARGS: Record<string, RegExp> = {
  build: /^[A-Za-z0-9_-]{1,20000}$/,
  profile: /^[A-Za-z0-9_.-]{1,120}\.json$/,
  vs: /^[A-Za-z0-9 _',.-]{1,200}$/,
  score: /^(rhythm|fight|safe)$/,
  screen: /^\d{1,5}$/,
  confirm: /^\d{1,5}$/,
  passes: /^\d{1,2}$/,
  only: /^[a-z_,]{1,200}$/,
  name: /^[A-Za-z0-9 _'.,()+-]{1,80}$/,
};

/**
 * POST /__combat/search: start a gear search from the page's build. It runs
 * detached from the dev server -- a restart or a closed tab does not stop a
 * long search -- with its output in combat/runs/web-<time>.log and the result
 * in combat/data/gear-search/web/<time>.json. The Live panel finds it by its
 * feed like any other search.
 */
async function searchStart(req: IncomingMessage, res: ServerResponse, dir: string) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const body = await readBody(req);
  if (!body) return json(res, 400, { error: 'not JSON' });
  const v: Record<string, string> = {};
  for (const [key, shape] of Object.entries(SEARCH_ARGS)) {
    const x = body[key];
    if (x === undefined || x === null || x === '') continue;
    if (!shape.test(String(x))) return json(res, 400, { error: `bad ${key}` });
    v[key] = String(x);
  }
  if (!v.build || !v.vs) return json(res, 400, { error: 'a build and something to fight' });
  if (v.profile && !existsSync(join(dir, 'profiles', v.profile))) return json(res, 400, { error: 'no such profile' });
  const extra = searchExtra(String(body.extra ?? ''));
  if (typeof extra === 'string') return json(res, 400, { error: extra });

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const out = `data/gear-search/web/${stamp}.json`;
  const log = `runs/web-${stamp}.log`;
  const argv = ['--experimental-strip-types', '--no-warnings', '--import', './register.mjs', 'tools/gear-search.ts',
    '--build', v.build, '--vs', v.vs, '--out', out];
  if (v.profile) argv.push('--profile', `profiles/${v.profile}`);
  if (v.name) argv.push('--name', v.name);
  // Rhythm scoring weighs the monsters by their spawns on the same maps (unless --map says otherwise).
  if (v.score === 'rhythm') argv.push('--score', 'rhythm', ...(extra.includes('--map') ? [] : ['--map', v.vs]));
  if (v.score === 'safe') argv.push('--score', 'safe');
  for (const k of ['screen', 'confirm', 'passes', 'only'] as const) if (v[k]) argv.push(`--${k}`, v[k]);
  if (body.perTarget === true) argv.push('--per-target');
  if (body.census === false) argv.push('--no-census');
  argv.push(...extra);

  mkdirSync(join(dir, 'runs'), { recursive: true });
  const fd = openSync(join(dir, log), 'w');
  try {
    const child = spawn(process.execPath, argv, { cwd: dir, detached: true, stdio: ['ignore', fd, fd], windowsHide: true });
    child.unref();
    json(res, 200, { pid: child.pid, log: `combat/${log}`, out: `combat/${out}` });
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  } finally {
    closeSync(fd);
  }
}

/**
 * POST /__combat/stop {pid}: end a running search. Only a pid with a live
 * feed is accepted -- this stops searches, not whatever else is running.
 */
async function searchStop(req: IncomingMessage, res: ServerResponse, dir: string) {
  if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
  const body = await readBody(req);
  const pid = Number(body?.pid);
  const file = join(dir, 'runs', 'live', `${pid}.json`);
  if (!Number.isInteger(pid) || pid <= 0 || !existsSync(file)) return json(res, 400, { error: 'not a search' });
  try {
    const feed = JSON.parse(readFileSync(file, 'utf8'));
    if (feed.status !== 'running') return json(res, 400, { error: 'already over' });
    process.kill(pid);
    // Its last write said "running": say otherwise, so the panel need not wait to call it stopped.
    writeFileSync(file, JSON.stringify({ ...feed, status: 'stopped', fightsPerSec: 0, updatedAt: Date.now() }));
    json(res, 200, { ok: true });
  } catch (e) {
    json(res, 500, { error: e instanceof Error ? e.message : String(e) });
  }
}

/**
 * Run the combat sim (../combat) from the dev server: POST /__combat/run.
 *
 * Dev only (`apply: 'serve'`): the sim is a local tool, not part of the site,
 * and never reaches a build. It runs as its own node process, exactly as
 * `npm run sim` does, so the page gets the same numbers as the terminal.
 * Arguments are checked against COMBAT_ARGS and passed as an argv array --
 * no shell -- so nothing typed on the page can become a command.
 */
function combatPlugin(): Plugin {
  const dir = join(ROOT, 'combat');
  return {
    name: 'rtmr-combat',
    apply: 'serve',
    configureServer(server) {
      // The searches running now (combat/src/live.ts): each writes its status
      // to runs/live/<pid>.json a few times a second. Those touched in the
      // last 10 minutes, newest first; a file caught mid-write is skipped.
      server.middlewares.use('/__combat/live', (_req, res) => {
        const live = join(dir, 'runs', 'live');
        const runs: unknown[] = [];
        if (existsSync(live)) {
          const files = readdirSync(live).filter((f) => f.endsWith('.json'))
            .map((f) => { try { return { f, t: statSync(join(live, f)).mtimeMs }; } catch { return { f, t: 0 }; } })
            .filter((x) => Date.now() - x.t < 600_000).sort((a, b) => b.t - a.t);
          for (const { f } of files) {
            try { runs.push(JSON.parse(readFileSync(join(live, f), 'utf8'))); } catch { /* mid-write */ }
          }
        }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        res.end(JSON.stringify({ now: Date.now(), runs }));
      });
      // The profiles a search can take its readings and rotation from, newest first.
      server.middlewares.use('/__combat/profiles', (_req, res) => {
        const pdir = join(dir, 'profiles');
        const list = readdirSync(pdir).filter((f) => f.endsWith('.json')).map((file) => {
          const p = join(pdir, file);
          let name = file;
          try { name = JSON.parse(readFileSync(p, 'utf8')).name ?? file; } catch { /* listed by file name */ }
          return { file, name, t: statSync(p).mtimeMs };
        }).sort((a, b) => b.t - a.t);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(list));
      });
      server.middlewares.use('/__combat/search', (req, res) => searchStart(req, res, dir));
      server.middlewares.use('/__combat/stop', (req, res) => searchStop(req, res, dir));
      server.middlewares.use('/__combat/run', (req, res) => {
        const reply = (code: number, body: unknown) => {
          res.statusCode = code;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.end(JSON.stringify(body));
        };
        if (req.method !== 'POST') return reply(405, { error: 'POST only' });
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; if (raw.length > 100_000) req.destroy(); });
        req.on('end', () => {
          let body: Record<string, unknown>;
          try { body = JSON.parse(raw); } catch { return reply(400, { error: 'not JSON' }); }
          // --stream: a line as each monster finishes, passed straight on, so
          // the panel can show progress instead of waiting for the lot.
          const argv = ['--experimental-strip-types', '--no-warnings', '--import', './register.mjs',
            'src/cli.ts', '--stream'];
          for (const [key, shape] of Object.entries(COMBAT_ARGS)) {
            const v = body[key];
            if (v === undefined || v === null || v === '') continue;
            if (!shape.test(String(v))) return reply(400, { error: `bad ${key}` });
            if (key === 'profile') {
              const file = `profiles/${v}.json`;
              if (!existsSync(resolve(dir, file))) return reply(400, { error: `no profile ${v}` });
              argv.push('--profile', file);
              continue;
            }
            argv.push(`--${key}`, String(v));
          }
          if (body.log) argv.push('--log');
          const child = spawn(process.execPath, argv, { cwd: dir });
          let err = '';
          const timer = setTimeout(() => child.kill(), 600_000);
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
          res.setHeader('Cache-Control', 'no-cache');
          child.stdout.on('data', (c) => res.write(c));
          child.stderr.on('data', (c) => { err += c; });
          // The page going away mid-run stops the fights. (Not req's 'close':
          // that fires once the body is read.)
          res.on('close', () => { if (!res.writableEnded && child.exitCode === null) child.kill(); });
          child.on('close', (code) => {
            clearTimeout(timer);
            // Headers are gone by now, so a failure is the stream's last line.
            if (code !== 0) {
              res.write(`${JSON.stringify({ type: 'error', error: err.trim() || `sim exited with ${code}` })}\n`);
            }
            res.end();
          });
        });
      });
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), datasetPlugin(), combatPlugin()],
  resolve: {
    alias: { '@sim': resolve(HERE, '../sim/src') },
  },
  server: { fs: { allow: [ROOT] } },
  // The suggestion search runs in a module worker (src/planner.worker.ts),
  // which imports the sim like the page does.
  worker: { format: 'es' },
});

