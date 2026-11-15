import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mp4Metadata, venueSegments, whiteBalance } from './ar-venue-lib.mjs';
const atom = (type, ...parts) => {
  const body = Buffer.concat(parts),
    head = Buffer.alloc(8);
  head.writeUInt32BE(body.length + 8);
  head.write(type, 4);
  return Buffer.concat([head, body]);
};
test('metadata distinguishes encoded sample rate from track duration and checks malformed boxes', () => {
  const tkhd = Buffer.alloc(84);
  tkhd.writeUInt32BE(1280 * 65536, 76);
  tkhd.writeUInt32BE(720 * 65536, 80);
  const mdhd = Buffer.alloc(24);
  mdhd.writeUInt32BE(30000, 12);
  mdhd.writeUInt32BE(60000, 16);
  const hdlr = Buffer.alloc(24);
  hdlr.write('vide', 8);
  const stts = Buffer.alloc(16);
  stts.writeUInt32BE(1, 4);
  stts.writeUInt32BE(60, 8);
  stts.writeUInt32BE(1000, 12);
  const bytes = atom(
    'moov',
    atom(
      'trak',
      atom('tkhd', tkhd),
      atom(
        'mdia',
        atom('mdhd', mdhd),
        atom('hdlr', hdlr),
        atom('minf', atom('stbl', atom('stts', stts))),
      ),
    ),
  );
  const m = mp4Metadata(bytes);
  assert.equal(m.fps, 30);
  assert.equal(m.duration_s, 2);
  assert.equal(m.width, 1280);
  assert.equal(m.height, 720);
  bytes.writeUInt32BE(bytes.length + 1, 0);
  assert.throws(() => mp4Metadata(bytes), /Invalid MP4/);
});
test('script labels clip to actual duration without inventing a still qualification', () => {
  assert.deepEqual(venueSegments(9.5).at(-1), { kind: 'arms_up_both', start_s: 8, end_s: 9.5 });
  assert.deepEqual(venueSegments(0), []);
});
test('white balance rejects black/invalid probes and computes channel gains', () => {
  assert.equal(whiteBalance([0, 1, 1]), null);
  assert.deepEqual(whiteBalance([0.5, 0.25, 0.125]), [0.5, 1, 2]);
});
