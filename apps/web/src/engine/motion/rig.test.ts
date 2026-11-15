import { describe, expect, it } from 'vitest';
import { decodeSatb } from './satb';
import {
  frameMatrices,
  invertAffine,
  matricesAt,
  parseFrames,
  parseRig,
  SkinBinding,
  skinVertices,
  transformPoint,
} from './rig';
import { fixtureAvailable, fixtureBuffer } from './testFixture';

/** Minimal SATB writer mirroring container.py (tests only). */
function encode(kind: string, blobs: Record<string, Float32Array | Uint8Array>) {
  const entries: {
    name: string;
    dtype: string;
    shape: number[];
    offset: number;
    byteLength: number;
  }[] = [];
  let header = '';
  let length = 0;
  for (let pass = 0; pass < 4; pass++) {
    let offset = 12 + length;
    offset += (16 - (offset % 16)) % 16;
    entries.length = 0;
    for (const [name, array] of Object.entries(blobs)) {
      entries.push({
        name,
        dtype: array instanceof Float32Array ? 'float32' : 'uint8',
        shape: [array.length],
        offset,
        byteLength: array.byteLength,
      });
      offset += array.byteLength + ((16 - (array.byteLength % 16)) % 16);
    }
    header = JSON.stringify({ kind, blobs: entries });
    const next = header.length + ((16 - ((12 + header.length) % 16)) % 16);
    if (next === length) break;
    length = next;
  }
  const end = entries.length
    ? entries[entries.length - 1].offset + entries[entries.length - 1].byteLength
    : 12 + length;
  const out = new Uint8Array(end + 16);
  out.set([83, 65, 84, 66]);
  const view = new DataView(out.buffer);
  view.setUint32(4, 1, true);
  view.setUint32(8, length, true);
  out.set(new TextEncoder().encode(header.padEnd(length, ' ')), 12);
  Object.values(blobs).forEach((array, i) =>
    out.set(new Uint8Array(array.buffer, array.byteOffset, array.byteLength), entries[i].offset),
  );
  return out.buffer;
}

describe('SATB container', () => {
  it('decodes typed blobs at their aligned offsets', () => {
    const file = decodeSatb(
      encode('test', { a: Float32Array.of(1.5, -2, 3), b: Uint8Array.of(7, 8) }),
      'test',
    );
    expect(Array.from(file.blobs.get('a')!.array)).toEqual([1.5, -2, 3]);
    expect(Array.from(file.blobs.get('b')!.array)).toEqual([7, 8]);
  });
  it('rejects other kinds and bad magic', () => {
    const buffer = encode('test', { a: Float32Array.of(1) });
    expect(() => decodeSatb(buffer, 'rig')).toThrow(/kind/);
    const bad = new Uint8Array(buffer.slice(0));
    bad[0] = 0;
    expect(() => decodeSatb(bad.buffer)).toThrow(/SATB/);
  });
});

describe('affine helpers', () => {
  it('inverts a rotation + translation exactly', () => {
    const c = Math.cos(0.7),
      s = Math.sin(0.7);
    const m = Float64Array.of(c, -s, 0, 0.3, s, c, 0, -0.2, 0, 0, 1, 1.1);
    const inv = invertAffine(m, 0, new Float64Array(12), 0);
    const p = transformPoint(m, 0, 0.1, 0.2, 0.3, new Float64Array(3));
    const q = transformPoint(inv, 0, p[0], p[1], p[2], new Float64Array(3));
    expect(q[0]).toBeCloseTo(0.1, 12);
    expect(q[1]).toBeCloseTo(0.2, 12);
    expect(q[2]).toBeCloseTo(0.3, 12);
  });
});

describe.skipIf(!fixtureAvailable('rig.bin', 'ref-lbs-reach_up_both.bin'))(
  "LBS vs P1's Python reference",
  () => {
    const rig = parseRig(fixtureBuffer('rig.bin'));
    for (const motion of ['reach_up_both', 'cross_arms', 'sit']) {
      it(`${motion}: every vertex within 0.001 mm of rig.lbs at the hold frame`, () => {
        const frames = parseFrames(fixtureBuffer(`frames-${motion}.bin`), rig.drivers.length);
        const hold = frames.motion.hold;
        const f = Math.round(0.5 * (hold.start_s + hold.end_s) * frames.fps);
        const out = skinVertices(
          rig,
          frameMatrices(frames, f, new Float64Array(216)),
          new Float32Array(rig.vertexCount * 3),
        );
        const ref = new Float32Array(fixtureBuffer(`ref-lbs-${motion}.bin`));
        let worst = 0;
        for (let i = 0; i < out.length; i += 3)
          worst = Math.max(
            worst,
            Math.hypot(out[i] - ref[i], out[i + 1] - ref[i + 1], out[i + 2] - ref[i + 2]),
          );
        expect(worst).toBeLessThan(1e-6);
      });
    }
    it('interpolates frames exactly at frame times', () => {
      const frames = parseFrames(fixtureBuffer('frames-sit.bin'), rig.drivers.length);
      const a = frameMatrices(frames, 12, new Float64Array(216)),
        b = matricesAt(frames, 12 / frames.fps, new Float64Array(216));
      for (let k = 0; k < 216; k++) expect(b[k]).toBeCloseTo(a[k], 9);
    });
    it('skin-bound points reproduce the vertex they are bound to', () => {
      const frames = parseFrames(fixtureBuffer('frames-reach_up_both.bin'), rig.drivers.length);
      const m0 = frameMatrices(frames, 0, new Float64Array(216)),
        m1 = frameMatrices(frames, 57, new Float64Array(216));
      const s0 = skinVertices(rig, m0, new Float32Array(rig.vertexCount * 3)),
        s1 = skinVertices(rig, m1, new Float32Array(rig.vertexCount * 3));
      const ids = [100, 5000, 9000];
      const points = ids.flatMap((v) => [s0[v * 3], s0[v * 3 + 1], s0[v * 3 + 2]]);
      const posed = new SkinBinding(rig, points, m0, s0).pose(m1, new Float64Array(9));
      ids.forEach((v, i) => {
        for (let k = 0; k < 3; k++) expect(posed[i * 3 + k]).toBeCloseTo(s1[v * 3 + k], 5);
      });
    });
  },
);
