// The baked hoods fitted onto shells (agent H). Node-only (vitest): reads the committed GLBs from
// apps/web/public/assets/hoods and, for the sweep, the shells fetched by
// scripts/blender/hood_sweep_fetch.py into .cache/hood/sweep/ (never committed; the sweep is
// skipped with a message when they are missing, like the P2 motion fixtures).
import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { HoodLayer, type ShellView } from './HoodLayer';
import { HOOD } from './hoodConfig';

type Fs = {
  existsSync(path: URL): boolean;
  readFileSync(path: URL): Uint8Array;
  readdirSync(path: URL): string[];
  writeFileSync(path: URL, data: string): void;
};
const fsModule = 'node:fs';
const fs = (await import(/* @vite-ignore */ fsModule)) as Fs;
const PUBLIC = new URL('../../../public/', import.meta.url);
const SWEEP = new URL('../../../../../.cache/hood/sweep/', import.meta.url);

function glbBytes(kind: number) {
  return fs.readFileSync(new URL(HOOD.assets[kind].split('?')[0].slice(1), PUBLIC));
}

async function hood(kind: number) {
  const bytes = glbBytes(kind);
  return HoodLayer.parse(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
}

describe('baked hood assets', () => {
  // The kiosk server caches /assets/ as immutable: each URL's ?v= must change with its GLB.
  it('each hood URL carries the first 8 hex of its GLB SHA-256', async () => {
    for (const kind of Object.keys(HOOD.assets).map(Number)) {
      const bytes = Uint8Array.from(glbBytes(kind));
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
      expect(HOOD.assets[kind], `re-baked GLB: set ?v=${hex.slice(0, 8)}`).toBe(
        `${HOOD.assets[kind].split('?')[0]}?v=${hex.slice(0, 8)}`,
      );
    }
  });
});

/** Area-weighted vertex normals (what GarmentLayer's normal attribute holds, up to smoothing). */
function normals(positions: ArrayLike<number>, triangles: ArrayLike<number>) {
  const n = new Float64Array(positions.length);
  for (let t = 0; t < triangles.length; t += 3) {
    const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]];
    const e1 = [0, 1, 2].map((k) => positions[b * 3 + k] - positions[a * 3 + k]);
    const e2 = [0, 1, 2].map((k) => positions[c * 3 + k] - positions[a * 3 + k]);
    const f = [
      e1[1] * e2[2] - e1[2] * e2[1],
      e1[2] * e2[0] - e1[0] * e2[2],
      e1[0] * e2[1] - e1[1] * e2[0],
    ];
    for (const v of [a, b, c]) for (let k = 0; k < 3; k++) n[v * 3 + k] += f[k];
  }
  for (let v = 0; v < n.length; v += 3) {
    const l = Math.hypot(n[v], n[v + 1], n[v + 2]) || 1;
    for (let k = 0; k < 3; k++) n[v + k] /= l;
  }
  return n;
}

/** A frame far from rest (hand pull / motion): smooth waves of up to 6 cm. */
function deformed(initial: readonly number[]) {
  return initial.map((v, i) => v + 0.06 * Math.sin(initial[i - (i % 3) + ((i + 1) % 3)] * 37 + i));
}

describe('padded hood fit, synthetic shell', () => {
  // A puffer-like shell: a U-shaped hood_zip row round the back of a neck (right front first).
  const n = 31;
  const initial: number[] = [];
  for (let k = 0; k < n; k++) {
    const a = (-Math.PI * 0.7 * (n - 1 - 2 * k)) / (n - 1); // -126 deg .. +126 deg from the back
    initial.push(0.07 * Math.sin(a), 1.5 + 0.03 * Math.cos(a), -0.06 * Math.cos(a));
  }
  const shell: ShellView = {
    key: 'synthetic',
    panels: Array(n).fill(6),
    triangles: [],
    paths: { hood_zip: Array.from({ length: n }, (_, k) => k) },
    maximum_loft_m: 0.0275,
    initial,
    colour: '#cdb89f',
    finish: 'glossy_ripstop',
  };
  const zero = new Float64Array(initial.length);

  it('fits, and a deformed frame never breaks the seam (ids come from the rest shape)', async () => {
    const h = await hood(2);
    expect(() => h.fitTo(shell, initial, zero)).not.toThrow();
    expect(Number.isFinite(h.lastFit!.residualMaxM)).toBe(true);
    expect(() => h.fitTo(shell, deformed(initial), zero)).not.toThrow();
    for (const t of [0, 0.3, 0.6, 1]) expect(() => h.setState('detached', t)).not.toThrow();
    const pos = h.mesh.geometry.getAttribute('position').array;
    expect(Array.from(pos).every(Number.isFinite)).toBe(true);
  });

  it('rejects non-finite frames (the layer then draws the shell hood, counted)', async () => {
    const h = await hood(2);
    h.fitTo(shell, initial, zero);
    const bad = initial.slice();
    bad[30] = Number.NaN;
    expect(() => h.fitTo(shell, bad, zero)).toThrow(/non-finite/);
  });

  it('rests the detached bowl on its zip edge at a target, opening up', async () => {
    const h = await hood(2);
    h.fitTo(shell, initial, zero);
    h.setState('detached', 1);
    const target = new Vector3(0.4, 0.75, 0.1);
    h.setRigidTransform(h.restingTransform(target, new Vector3(0, 0, 1)));
    const g = h.mesh.geometry;
    const pos = g.getAttribute('position').array;
    const attach = g.getAttribute('_attach').array;
    let n = 0,
      minY = Infinity,
      maxY = -Infinity;
    const c = new Vector3();
    for (let v = 0; v < attach.length; v++) {
      if (attach[v] < 0.5) continue;
      c.add(new Vector3(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]));
      minY = Math.min(minY, pos[v * 3 + 1]);
      maxY = Math.max(maxY, pos[v * 3 + 1]);
      n++;
    }
    c.divideScalar(n);
    expect(c.distanceTo(target)).toBeLessThan(1e-6); // zip edge centred on the target
    expect(maxY - minY).toBeLessThan(0.03); // zip edge level (within its own curvature)
    let top = -Infinity;
    for (let v = 1; v < pos.length; v += 3) top = Math.max(top, pos[v]);
    expect(top - target.y).toBeGreaterThan(0.12); // the bowl stands up from it
  });

  it('the parka hood is sewn in', async () => {
    const h = await hood(1);
    expect(h.info.removable).toBe(false);
    expect(() => h.setState('detached', 0.5)).toThrow(/sewn in/);
  });
});

const files = fs.existsSync(SWEEP) ? fs.readdirSync(SWEEP).filter((f) => f.endsWith('.json')) : [];
if (!files.length)
  console.warn(
    'Hood sweep fixtures missing, sweep skipped: run scripts/blender/hood_sweep_fetch.py with the API running',
  );

describe.skipIf(!files.length)('padded hood fit sweep (soak bodies + extremes, every size)', () => {
  it('fits every shell, at rest and on a deformed frame, with a bounded seam residual', async () => {
    const hoods = { 1: await hood(1), 2: await hood(2) } as Record<number, HoodLayer>;
    const rows: Record<string, number | string>[] = [];
    for (const file of files) {
      const shell = JSON.parse(
        new TextDecoder().decode(fs.readFileSync(new URL(file, SWEEP))),
      ) as ShellView & { render_details: { hood_kind: number }; size: string };
      const h = hoods[shell.render_details.hood_kind];
      const nrm = normals(shell.initial, shell.triangles);
      h.fitTo(shell, shell.initial, nrm);
      const rest = h.lastFit!;
      h.fitTo(shell, deformed(shell.initial), nrm);
      rows.push({
        file,
        rawScale: +rest.rawScale.toFixed(4),
        scale: +rest.scale.toFixed(4),
        residualMaxCm: +(rest.residualMaxM * 100).toFixed(2),
      });
      // A real hood does not shrink with a narrow shell collar: the scale stays in the grading
      // bounds and the seam blend gathers the zip edge onto the collar (bounded residual).
      expect(rest.scale, file).toBeGreaterThanOrEqual(HOOD.minScale);
      expect(rest.scale, file).toBeLessThanOrEqual(HOOD.maxScale);
      expect(rest.residualMaxM, file).toBeLessThan(0.06);
    }
    const summary = {
      shells: rows.length,
      rawScale: [
        Math.min(...rows.map((r) => +r.rawScale)),
        Math.max(...rows.map((r) => +r.rawScale)),
      ],
      residualMaxCm: Math.max(...rows.map((r) => +r.residualMaxCm)),
      rows,
    };
    fs.writeFileSync(new URL('../sweep-result.json', SWEEP), JSON.stringify(summary, null, 1));
    console.log(
      `hood sweep: ${rows.length} shells, raw scale ${summary.rawScale.join('..')}, worst residual ${summary.residualMaxCm} cm`,
    );
  }, 120_000);
});
