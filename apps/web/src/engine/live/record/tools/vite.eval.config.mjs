// Vite config for V3's evaluation runs (videoEval.mjs): the app's config with HMR and the file
// watcher off. Other agents edit engine/live/** while an evaluation runs; with HMR on, Vite
// reloaded the evaluation page mid-run ("Execution context was destroyed").
import { fileURLToPath } from 'node:url';
import base from '../../../../../vite.config.ts';

export default {
  ...base,
  root: fileURLToPath(new URL('../../../../../', import.meta.url)),
  server: { ...base.server, hmr: false, watch: null },
};
