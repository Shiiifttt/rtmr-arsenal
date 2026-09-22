/** Resolve the '@sim' alias the way vite.config.ts does, for `node --test`. */

const SIM = new URL('../../sim/src/index.ts', import.meta.url).href;

export function resolve(specifier, context, next) {
  if (specifier === '@sim') return { url: SIM, shortCircuit: true };
  return next(specifier, context);
}
