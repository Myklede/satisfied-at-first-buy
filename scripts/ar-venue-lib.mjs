// Local MP4 metadata without ffprobe or another dependency. Unsupported files fail explicitly.
function boxes(bytes, start = 0, end = bytes.length) {
  const out = [];
  for (let at = start; at + 8 <= end; ) {
    let size = bytes.readUInt32BE(at),
      header = 8;
    const type = bytes.toString('ascii', at + 4, at + 8);
    if (size === 1) {
      if (at + 16 > end) throw new Error('Truncated extended box');
      size = Number(bytes.readBigUInt64BE(at + 8));
      header = 16;
    }
    if (size === 0) size = end - at;
    if (!Number.isSafeInteger(size) || size < header || at + size > end)
      throw new Error('Invalid MP4 box size');
    out.push({ type, start: at + header, end: at + size });
    at += size;
  }
  return out;
}
export function mp4Metadata(bytes) {
  const children = (b) => (b ? boxes(bytes, b.start, b.end) : []);
  const moov = boxes(bytes).find((b) => b.type === 'moov');
  if (!moov) throw new Error('MP4 has no moov metadata');
  for (const trak of children(moov).filter((b) => b.type === 'trak')) {
    const track = children(trak),
      mdia = track.find((b) => b.type === 'mdia'),
      media = children(mdia);
    const hdlr = media.find((b) => b.type === 'hdlr');
    if (!hdlr || bytes.toString('ascii', hdlr.start + 8, hdlr.start + 12) !== 'vide') continue;
    const mdhd = media.find((b) => b.type === 'mdhd'),
      tkhd = track.find((b) => b.type === 'tkhd');
    if (!mdhd || !tkhd) throw new Error('Video track missing headers');
    const version = bytes[mdhd.start],
      timeOffset = mdhd.start + (version === 1 ? 20 : 12);
    if (![0, 1].includes(version)) throw new Error('Unsupported mdhd version');
    const timescale = bytes.readUInt32BE(timeOffset);
    const duration =
      version === 1
        ? Number(bytes.readBigUInt64BE(timeOffset + 4))
        : bytes.readUInt32BE(timeOffset + 4);
    if (!timescale || !Number.isSafeInteger(duration)) throw new Error('Invalid MP4 timebase');
    const stbl = children(media.find((b) => b.type === 'minf')).find((b) => b.type === 'stbl');
    const stts = children(stbl).find((b) => b.type === 'stts');
    let frames = 0,
      ticks = 0;
    if (stts) {
      const count = bytes.readUInt32BE(stts.start + 4);
      if (stts.start + 8 + count * 8 > stts.end) throw new Error('Invalid sample timing table');
      for (let i = 0; i < count; i++) {
        const samples = bytes.readUInt32BE(stts.start + 8 + i * 8),
          delta = bytes.readUInt32BE(stts.start + 12 + i * 8);
        frames += samples;
        ticks += samples * delta;
      }
    }
    return {
      width: bytes.readUInt32BE(tkhd.end - 8) / 65536,
      height: bytes.readUInt32BE(tkhd.end - 4) / 65536,
      duration_s: duration / timescale,
      fps: ticks > 0 ? (frames * timescale) / ticks : null,
      frames,
      fpsBasis:
        'Mean encoded sample cadence from stts; VFR is not a constant frame-rate claim. Track display size from tkhd, rotation not applied.',
    };
  }
  throw new Error('No supported MP4 video track');
}

// Approximate recording-script labels. Stillness MUST be independently qualified from landmarks.
export function venueSegments(duration) {
  const spec = [
    ['still', 0, 8],
    ['arms_up_both', 8, 12],
    ['arms_up_one', 12, 15],
    ['cross_arms', 15, 19],
    ['turn', 19, 24],
    ['back', 24, 27],
    ['enter_exit', 27, 30],
  ];
  return spec
    .filter(([, start]) => start < duration)
    .map(([kind, start_s, end]) => ({ kind, start_s, end_s: Math.min(end, duration) }));
}

export function whiteBalance(rgb) {
  if (rgb.length !== 3 || rgb.some((v) => !Number.isFinite(v) || v <= 0)) return null;
  return rgb.map((v) => rgb[1] / v);
}
