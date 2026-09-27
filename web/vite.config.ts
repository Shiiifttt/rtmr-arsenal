import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
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
};

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

