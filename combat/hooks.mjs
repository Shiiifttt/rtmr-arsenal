/** Resolve the '@sim' alias, as web/test/hooks.mjs does for the web tests. */

const SIM = new URL('../sim/src/index.ts', import.meta.url).href;

export function resolve(specifier, context, next) {
  if (specifier === '@sim') return { url: SIM, shortCircuit: true };
  return next(specifier, context);
}
