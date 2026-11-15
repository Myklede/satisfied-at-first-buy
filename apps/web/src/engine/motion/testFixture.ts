// Test-only access to the P2 fixture in .cache/motion-fit/ (public reference body, generated
// by scripts/motion-fit-fixture.py and scripts/motion-fit-fetch.mjs; never committed). Tests
// that need it are skipped with a message when it is missing. Node-only (vitest).
type Fs = { existsSync(path: URL): boolean; readFileSync(path: URL): Uint8Array };

export const MISSING =
  'P2 fixture missing, fixture tests skipped: run `.venv/Scripts/python.exe ' +
  'scripts/motion-fit-fixture.py` and `node scripts/motion-fit-fetch.mjs` with the API running';
const ROOT = new URL('../../../../../.cache/motion-fit/', import.meta.url);
const fsModule = 'node:fs';
const fs = (await import(/* @vite-ignore */ fsModule)) as Fs;

export const fixtureAvailable = (...names: string[]) => {
  const ok = names.every((name) => fs.existsSync(new URL(name, ROOT)));
  if (!ok) console.warn(MISSING);
  return ok;
};

export function fixtureBuffer(name: string): ArrayBuffer {
  const bytes = fs.readFileSync(new URL(name, ROOT));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function fixtureJson<T>(name: string): T {
  return JSON.parse(new TextDecoder().decode(fs.readFileSync(new URL(name, ROOT)))) as T;
}
