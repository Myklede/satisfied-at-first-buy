// Node module hook for the PSD tools (agent V7): Node's built-in type stripping refuses some
// TypeScript (parameter properties, e.g. garmentSkin.ts's Grid), so .ts sources are transpiled
// with the repo's own esbuild (a Vite dependency; no new package). Tools import this first, then
// load the engine modules with dynamic import().
import { registerHooks } from 'node:module';
import { transformSync } from 'esbuild';

registerHooks({
  load(url, context, nextLoad) {
    if (!url.startsWith('file:') || !url.endsWith('.ts')) return nextLoad(url, context);
    const loaded = nextLoad(url, { ...context, format: 'module' });
    const source =
      typeof loaded.source === 'string' ? loaded.source : new TextDecoder().decode(loaded.source);
    const { code } = transformSync(source, {
      loader: 'ts',
      format: 'esm',
      target: 'es2022',
      sourcefile: url,
    });
    return { format: 'module', source: code, shortCircuit: true };
  },
});
