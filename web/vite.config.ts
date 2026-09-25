import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
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

export default defineConfig({
  base: './',
  plugins: [react(), datasetPlugin()],
  resolve: {
    alias: { '@sim': resolve(HERE, '../sim/src') },
  },
  server: { fs: { allow: [ROOT] } },
  // The suggestion search runs in a module worker (src/planner.worker.ts),
  // which imports the sim like the page does.
  worker: { format: 'es' },
});

