import { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { BenchStudio } from './BenchStudio';
import './style.css';

// Kiosk route (/?kiosk): loaded lazily so the studio and ?bench bundles are unchanged.
const KioskApp = lazy(() => import('./kiosk/KioskApp').then((m) => ({ default: m.KioskApp })));
// Fit-in-motion route (/?motion, agent P2): lazy as well.
const MotionStudioRoute = lazy(() =>
  import('./motion/MotionStudio').then((m) => ({ default: m.MotionStudioRoute })),
);
// Jacket look-dev sandbox (/?sandbox): lazy as well.
const SandboxStudio = lazy(() =>
  import('./sandbox/SandboxStudio').then((m) => ({ default: m.SandboxStudio })),
);
// Live try-on dev labs (prompt 14): /?mirrorlab (agent V1) and /?arlab (agent V2). Not judge routes.
const MirrorLab = lazy(() =>
  import('./labs/mirror/MirrorLab').then((m) => ({ default: m.MirrorLab })),
);
const ArLab = lazy(() => import('./labs/ar/ArLab').then((m) => ({ default: m.ArLab })));
const params = new URLSearchParams(location.search);

createRoot(document.getElementById('root')!).render(
  params.has('arcapture') ? <Suspense fallback={null}>{(() => { const C = lazy(() => import('./labs/capture/CaptureLab')); return <C />; })()}</Suspense> :
  params.has('kiosk') ? (
    <Suspense fallback={null}>
      <KioskApp />
    </Suspense>
  ) : params.has('motion') ? (
    <Suspense fallback={null}>
      <MotionStudioRoute />
    </Suspense>
  ) : params.has('sandbox') ? (
    <Suspense fallback={null}>
      <SandboxStudio />
    </Suspense>
  ) : params.has('mirrorlab') ? (
    <Suspense fallback={null}>
      <MirrorLab />
    </Suspense>
  ) : params.has('arlab') ? (
    <Suspense fallback={null}>
      <ArLab />
    </Suspense>
  ) : params.has('bench') ? (
    <BenchStudio />
  ) : (
    <App />
  ),
);
