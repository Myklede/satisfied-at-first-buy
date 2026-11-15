// Standalone check of the Fit Lab (apps/web/fitlab-dev.html): the panel with a stub bus and the
// synthetic pose (no camera). Query: ?jacket=FB7675-100|DQ4920-206&size=S|M|L&reveal=0..1&zip=0..1
import type { JacketId, SizeLabel } from '../contract';
import { FitLab } from './FitLabPanel';
import { StubBus, SyntheticPerception } from './devStubs';
import { verdictLine } from './verdict';

const q = new URLSearchParams(location.search);
const jacket = (q.get('jacket') === 'DQ4920-206' ? 'DQ4920-206' : 'FB7675-100') as JacketId;
const size = (['S', 'M', 'L'].includes(q.get('size') ?? '') ? q.get('size') : 'M') as SizeLabel;
const reveal = Math.min(1, Math.max(0, Number(q.get('reveal') ?? '0') || 0));

const zip = Number(q.get('zip') ?? '0.5');
const bus = new StubBus({
  jacket,
  size,
  zip: Number.isFinite(zip) ? zip : 0.5,
  hoodOn: true,
  hemPull: 0,
});
const perception = new SyntheticPerception();
const lab = new FitLab({ reveal });
const out = document.getElementById('out')!;
const log = (text: string) => (out.textContent = text);

document
  .querySelectorAll<HTMLButtonElement>('[data-jacket]')
  .forEach((b) =>
    b.addEventListener('click', () => bus.set({ jacket: b.dataset.jacket as JacketId }, 'ui')),
  );
document
  .querySelectorAll<HTMLButtonElement>('[data-size]')
  .forEach((b) =>
    b.addEventListener('click', () => bus.set({ size: b.dataset.size as SizeLabel }, 'ui')),
  );
document
  .querySelectorAll<HTMLButtonElement>('[data-zip]')
  .forEach((b) =>
    b.addEventListener('click', () => bus.set({ zip: Number(b.dataset.zip) }, 'slider')),
  );
bus.subscribe(() => show());

function show() {
  const v = lab.verdict();
  const s = bus.get();
  log(
    `bus: ${s.jacket} ${s.size}\n` +
      (v
        ? `recommended: ${v.recommended} (${v.recommendedBasis}; service said ${v.serviceRecommended})\n` +
          (['S', 'M', 'L'] as const).map((n) => verdictLine(n, v.sizes[n])).join('\n') +
          `\nlayer ${v.layerCm} cm, ${v.preference}; heatmap ${v.heatmapTightCm}/${v.heatmapLooseCm} cm`
        : 'verdict: loading…'),
  );
}

lab.onStatus((s) => {
  show();
  document.getElementById('status')!.textContent = `${s.phase}: ${s.message} · pose ${s.poseHz} Hz`;
});
Object.assign(window as unknown as Record<string, unknown>, { fitlab: lab, fitbus: bus });
void perception.start();
lab
  .mount(document.getElementById('panel')!, { bus, perception })
  .then(show)
  .catch((e: unknown) => log(`mount failed: ${e instanceof Error ? e.message : String(e)}`));

// Dev diagnostics (fitlab-dev.html only).
Object.assign(window as unknown as Record<string, unknown>, {
  fitlabDebug: () => {
    const l = lab as unknown as {
      shells?: { ready: boolean; selected?: string; layers(): import('three').Object3D[] };
      engine?: { kioskView?: { viewer: { garment: import('three').Object3D } } };
    };
    const layers = l.shells?.layers() ?? [];
    return {
      ready: l.shells?.ready,
      selected: l.shells?.selected,
      garmentVisible: l.engine?.kioskView?.viewer.garment.visible,
      layers: layers.map((o) => {
        let meshes = 0;
        let first = '';
        o.traverse((c) => {
          const m = c as import('three').Mesh;
          if (m.isMesh) {
            meshes++;
            if (!first) {
              const a = m.geometry.getAttribute('position');
              first = `${a.count} ${a.getX(0).toFixed(3)},${a.getY(0).toFixed(3)} vis ${m.visible} mat ${(m.material as { opacity?: number }).opacity}`;
            }
          }
        });
        return { visible: o.visible, parent: !!o.parent, meshes, first };
      }),
    };
  },
});
