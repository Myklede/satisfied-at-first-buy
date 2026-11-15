// F2 (prompt 23, D9): three's BufferGeometry.computeBoundingSphere and computeVertexNormals walk
// every vertex through Vector3.fromBufferAttribute/setXYZ. The live try-on calls them several
// times per pose on the same body and jacket meshes (LiveAvatar, the AR and mirror GarmentLayers,
// HoodLayer): in the kiosk CPU profile (venue clip, pose worker on) fromBufferAttribute,
// setFromBufferAttribute, computeBoundingSphere and computeVertexNormals were ≈ 0.8 s of 8 s of
// main-thread time. These are the same algorithms on the raw typed arrays, with the same
// floating-point operations in the same order, so the results are bit-identical (unit-tested
// against three's own). Anything unusual (interleaved, normalized, non-float, morph targets, GL
// attributes) falls back to three's implementation. Opt-in: ?fastGeom=1 (installFastGeometry).
import { BufferAttribute, BufferGeometry, Sphere } from 'three';

type Patched = {
  computeBoundingSphere: BufferGeometry['computeBoundingSphere'];
  computeVertexNormals: BufferGeometry['computeVertexNormals'];
};
let original: Patched | null = null;

const plainFloat3 = (a: unknown): a is BufferAttribute & { array: Float32Array } =>
  a instanceof BufferAttribute &&
  a.itemSize === 3 &&
  !a.normalized &&
  a.array instanceof Float32Array;

/** Bit-identical to three r181 computeBoundingSphere for plain Float32 xyz positions. */
export function fastBoundingSphere(geometry: BufferGeometry): boolean {
  const position = geometry.attributes.position;
  if (!plainFloat3(position) || geometry.morphAttributes.position || position.count === 0)
    return false;
  const a = position.array,
    n = position.count;
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity,
    maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;
  for (let i = 0; i < n; i++) {
    const x = a[i * 3],
      y = a[i * 3 + 1],
      z = a[i * 3 + 2];
    // Box3.expandByPoint: min.min(p), max.max(p) (Math.min/Math.max per component).
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    minZ = Math.min(minZ, z);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    maxZ = Math.max(maxZ, z);
  }
  geometry.boundingSphere ??= new Sphere();
  const center = geometry.boundingSphere.center;
  // Box3.getCenter: (min + max) * 0.5.
  center.set((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5);
  const cx = center.x,
    cy = center.y,
    cz = center.z;
  let maxRadiusSq = 0;
  for (let i = 0; i < n; i++) {
    // Vector3.distanceToSquared: dx = this.x - v.x, …; dx * dx + dy * dy + dz * dz.
    const dx = cx - a[i * 3],
      dy = cy - a[i * 3 + 1],
      dz = cz - a[i * 3 + 2];
    maxRadiusSq = Math.max(maxRadiusSq, dx * dx + dy * dy + dz * dz);
  }
  geometry.boundingSphere.radius = Math.sqrt(maxRadiusSq);
  if (isNaN(geometry.boundingSphere.radius))
    console.error(
      'THREE.BufferGeometry.computeBoundingSphere(): Computed radius is NaN. The "position" attribute is likely to have NaN values.',
      geometry,
    );
  return true;
}

/** Bit-identical to three r181 computeVertexNormals (indexed) for plain Float32 attributes. */
export function fastVertexNormals(geometry: BufferGeometry): boolean {
  const index = geometry.index;
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  if (!index || index.itemSize !== 1 || index.normalized) return false;
  if (!plainFloat3(position) || !plainFloat3(normal) || normal.count !== position.count)
    return false;
  const ix = index.array,
    p = position.array,
    out = normal.array;
  out.fill(0);
  for (let i = 0, il = index.count; i < il; i += 3) {
    const a = ix[i] * 3,
      b = ix[i + 1] * 3,
      c = ix[i + 2] * 3;
    // cb = pC − pB, ab = pA − pB, cb × ab (Vector3.crossVectors order).
    const cbx = p[c] - p[b],
      cby = p[c + 1] - p[b + 1],
      cbz = p[c + 2] - p[b + 2];
    const abx = p[a] - p[b],
      aby = p[a + 1] - p[b + 1],
      abz = p[a + 2] - p[b + 2];
    const x = cby * abz - cbz * aby,
      y = cbz * abx - cbx * abz,
      z = cbx * aby - cby * abx;
    // nX.add(cb) then setXYZ: each sum is rounded to float32 on store, as in three.
    out[a] = out[a] + x;
    out[a + 1] = out[a + 1] + y;
    out[a + 2] = out[a + 2] + z;
    out[b] = out[b] + x;
    out[b + 1] = out[b + 1] + y;
    out[b + 2] = out[b + 2] + z;
    out[c] = out[c] + x;
    out[c + 1] = out[c + 1] + y;
    out[c + 2] = out[c + 2] + z;
  }
  // normalizeNormals: v.normalize() = v.divideScalar(v.length() || 1) = v * (1 / s).
  for (let i = 0; i < out.length; i += 3) {
    const x = out[i],
      y = out[i + 1],
      z = out[i + 2];
    const k = 1 / (Math.sqrt(x * x + y * y + z * z) || 1);
    out[i] = x * k;
    out[i + 1] = y * k;
    out[i + 2] = z * k;
  }
  normal.needsUpdate = true;
  return true;
}

/** Patches BufferGeometry.prototype (idempotent); returns an uninstall function. */
export function installFastGeometry(): () => void {
  if (!original) {
    const proto = BufferGeometry.prototype;
    const saved: Patched = {
      computeBoundingSphere: proto.computeBoundingSphere,
      computeVertexNormals: proto.computeVertexNormals,
    };
    original = saved;
    proto.computeBoundingSphere = function (this: BufferGeometry) {
      if (!fastBoundingSphere(this)) saved.computeBoundingSphere.call(this);
    };
    proto.computeVertexNormals = function (this: BufferGeometry) {
      if (!fastVertexNormals(this)) saved.computeVertexNormals.call(this);
    };
  }
  return () => {
    if (!original) return;
    BufferGeometry.prototype.computeBoundingSphere = original.computeBoundingSphere;
    BufferGeometry.prototype.computeVertexNormals = original.computeVertexNormals;
    original = null;
  };
}
