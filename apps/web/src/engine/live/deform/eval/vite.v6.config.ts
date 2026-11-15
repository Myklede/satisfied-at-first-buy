// V6's evaluation dev server: the web app's own Vite config with HMR and file watching off, so a
// file saved by another agent mid-run cannot reload the page. Run from apps/web:
//   npx vite --config src/engine/live/deform/eval/vite.v6.config.ts --port 5800 --strictPort
import { mergeConfig } from 'vite';
import base from '../../../../../vite.config';

export default mergeConfig(base, {
  server: { hmr: false, watch: { ignored: ['**/*'] } },
});
