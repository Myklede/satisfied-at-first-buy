// Deep copy of a simulation object graph (ClothSolver + ArticulatedCollider after the relax), so
// a later bake can start from exactly the same state. Typed arrays get their own buffers (views
// that shared a buffer still share the copy), class instances keep their prototype, and objects
// in `shared` (read-only inputs: the cloth asset, rig, SDF, static grid) are kept by reference.
// Functions are refused: a closure would still point at the original object.

type View = ArrayBufferView & { length: number };
type ViewConstructor = new (buffer: ArrayBufferLike, byteOffset: number, length: number) => View;

export function cloneState<T>(value: T, shared: ReadonlySet<unknown>): T {
  return copier(shared)(value) as T;
}

/**
 * Writes a deep copy of every own property of `source` into `target`, an object of the same
 * class made by its constructor. Hot code then sees objects of the constructor's shape: a bake
 * on a cloneState() copy itself ran 30–50 % slower per step (measured, prompts/06 item E).
 * `replace` maps objects inside `source` to ready copies (e.g. the solver's collider).
 */
export function restoreInto<T extends object>(
  target: T,
  source: T,
  shared: ReadonlySet<unknown>,
  replace?: ReadonlyMap<unknown, unknown>,
) {
  if (Object.getPrototypeOf(target) !== Object.getPrototypeOf(source))
    throw new Error('restoreInto: different classes');
  const visit = copier(shared, replace),
    from = source as Record<PropertyKey, unknown>,
    to = target as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(from)) to[key] = visit(from[key]);
  return target;
}

function copier(shared: ReadonlySet<unknown>, replace?: ReadonlyMap<unknown, unknown>) {
  const memo = new Map<unknown, unknown>(replace ?? []),
    buffers = new Map<ArrayBufferLike, ArrayBufferLike>();
  const visit = (v: unknown): unknown => {
    if (typeof v === 'function') throw new Error('cloneState: function-valued state');
    if (v === null || typeof v !== 'object' || shared.has(v)) return v;
    const seen = memo.get(v);
    if (seen !== undefined) return seen;
    let out: unknown;
    if (ArrayBuffer.isView(v)) {
      if (v instanceof DataView) throw new Error('cloneState: DataView state');
      const view = v as View;
      let buffer = buffers.get(view.buffer);
      if (!buffer) buffers.set(view.buffer, (buffer = view.buffer.slice(0)));
      out = new (view.constructor as ViewConstructor)(buffer, view.byteOffset, view.length);
      memo.set(v, out);
    } else if (v instanceof Map) {
      const map = new Map<unknown, unknown>();
      memo.set(v, map);
      for (const [key, item] of v) map.set(visit(key), visit(item));
      out = map;
    } else if (v instanceof Set) {
      const set = new Set<unknown>();
      memo.set(v, set);
      for (const item of v) set.add(visit(item));
      out = set;
    } else if (Array.isArray(v)) {
      const array: unknown[] = new Array(v.length);
      memo.set(v, array);
      for (let i = 0; i < v.length; i++) array[i] = visit(v[i]);
      out = array;
    } else {
      const object = Object.create(Object.getPrototypeOf(v)) as Record<PropertyKey, unknown>;
      memo.set(v, object);
      const source = v as Record<PropertyKey, unknown>;
      for (const key of Reflect.ownKeys(source)) object[key] = visit(source[key]);
      out = object;
    }
    return out;
  };
  return visit;
}
