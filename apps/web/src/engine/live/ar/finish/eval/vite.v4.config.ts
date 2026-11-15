// V4's evaluation dev server: the web app's own Vite config with HMR and file watching off, so a
// file saved by any agent while the evaluation runs cannot reload the page under it (a reload
// killed a run mid-sample, 2026-11-13). Run from apps/web:
//   npx vite --config src/engine/live/ar/finish/eval/vite.v4.config.ts --port 5786 --strictPort
import { mergeConfig } from 'vite';
import base from '../../../../../../vite.config';

export default mergeConfig(base, {
  server: { hmr: false, watch: { ignored: ['**/*'] } },
});
