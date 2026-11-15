// `SATB` binary container (services/body/body_service/motion/FORMAT.md, container.py):
// magic "SATB", uint32 LE version 1, uint32 LE header length H, UTF-8 JSON header, then
// little-endian blobs at 16-byte aligned offsets counted from byte 0. Pure, no DOM.

export type SatbDtype = 'float32' | 'uint32' | 'int32' | 'uint16' | 'uint8';
export type SatbBlobEntry = {
  name: string;
  dtype: SatbDtype;
  shape: number[];
  offset: number;
  byteLength: number;
};
export type SatbArray = Float32Array | Uint32Array | Int32Array | Uint16Array | Uint8Array;
export type SatbBlob = { array: SatbArray; shape: number[]; dtype: SatbDtype };
export type SatbFile = {
  header: Record<string, unknown> & { kind: string };
  blobs: Map<string, SatbBlob>;
};

const BYTES: Record<SatbDtype, number> = { float32: 4, uint32: 4, int32: 4, uint16: 2, uint8: 1 };

export function decodeSatb(buffer: ArrayBuffer, expectedKind?: string): SatbFile {
  if (buffer.byteLength < 16) throw new Error('SATB container too short');
  const bytes = new Uint8Array(buffer);
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'SATB')
    throw new Error('Not a SATB container');
  const view = new DataView(buffer);
  const version = view.getUint32(4, true),
    headerLength = view.getUint32(8, true);
  if (version !== 1) throw new Error(`Unsupported SATB version ${version}`);
  if (12 + headerLength > buffer.byteLength) throw new Error('SATB header overruns the file');
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + headerLength))) as {
    kind: string;
    blobs: SatbBlobEntry[];
  } & Record<string, unknown>;
  if (expectedKind && header.kind !== expectedKind)
    throw new Error(`Expected SATB kind ${expectedKind}, got ${header.kind}`);
  const blobs = new Map<string, SatbBlob>();
  for (const entry of header.blobs) {
    const size = BYTES[entry.dtype];
    if (!size) throw new Error(`Unsupported SATB dtype ${entry.dtype}`);
    const count = entry.shape.reduce((a, b) => a * b, 1);
    if (count * size !== entry.byteLength || entry.offset % 16 !== 0)
      throw new Error(`SATB blob ${entry.name} has an inconsistent layout`);
    if (entry.offset + entry.byteLength > buffer.byteLength)
      throw new Error(`SATB blob ${entry.name} overruns the file`);
    const array =
      entry.dtype === 'float32'
        ? new Float32Array(buffer, entry.offset, count)
        : entry.dtype === 'uint32'
          ? new Uint32Array(buffer, entry.offset, count)
          : entry.dtype === 'int32'
            ? new Int32Array(buffer, entry.offset, count)
            : entry.dtype === 'uint16'
              ? new Uint16Array(buffer, entry.offset, count)
              : new Uint8Array(buffer, entry.offset, count);
    blobs.set(entry.name, { array, shape: entry.shape, dtype: entry.dtype });
  }
  return { header, blobs };
}

export function blob<T extends SatbArray>(
  file: SatbFile,
  name: string,
  type: new (...args: never[]) => T,
  shape?: (number | null)[],
): T {
  const entry = file.blobs.get(name);
  if (!entry) throw new Error(`SATB blob ${name} missing`);
  if (!(entry.array instanceof type)) throw new Error(`SATB blob ${name} has dtype ${entry.dtype}`);
  if (
    shape &&
    (shape.length !== entry.shape.length ||
      shape.some((n, i) => n !== null && n !== entry.shape[i]))
  )
    throw new Error(`SATB blob ${name} has shape ${entry.shape.join('×')}`);
  return entry.array as T;
}
