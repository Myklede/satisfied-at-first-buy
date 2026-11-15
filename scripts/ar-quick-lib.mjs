// P22 selection, comparison and table formatting; no pixels or private body data.
// Operator sampling budget, not product/model quality settings. The full kiosk profile
// settles for5s; this bounded diagnostic settles for1s after its first drawn frame.
export const QUICK_PROTOCOL = { qualitySeconds: 8, kioskSeconds: 4, kioskWarmupMs: 1000 };
export const QUICK_METRICS = [
  'stillPx',
  'rotationDeg',
  'scalePct',
  'onsetFrames',
  'residualPx',
  'uncoveredPct',
  'kioskArFps',
  'processingMs',
];

export function quickFlags(value = '') {
  const params = new URLSearchParams(value);
  // F5 2026-11-14: any agent feature flag (f1turn, f3arms, f4edge, posePipe, ...) passes;
  // identity/body/source keys never do (they would change the case, not the feature).
  const blocked = new Set([
    'arlab',
    'jacket',
    'size',
    'h',
    'w',
    'sex',
    'source',
    't',
    'mirror',
    'nomirror',
  ]);
  for (const [key, v] of params)
    if (
      blocked.has(key) ||
      !/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(key) ||
      !/^[a-zA-Z0-9_.,:-]{1,32}$/.test(v)
    )
      throw new Error(`Unsupported A/B flag: ${key}`);
  return params;
}

export function quickClips(manifest) {
  const cross =
    manifest.find(
      (r) => r.file.includes('11569') && r.segments.some((s) => s.kind === 'cross_arms'),
    ) ?? manifest.find((r) => r.segments.some((s) => s.kind === 'cross_arms'));
  const dark = manifest.find(
    (r) => /dark.*(?:top|polo|hoodie|shirt)/i.test(r.clothing) && r.file !== cross?.file,
  );
  if (!cross || !dark) throw new Error('Manifest must contain crossed-arms and dark-top clips');
  const stock = (r, id) => {
    if (!/^stock\/[a-zA-Z0-9_.-]+\.mp4$/.test(r.file)) throw new Error('Invalid stock path');
    return {
      id,
      file: `data/test-videos/${r.file}`,
      segments: r.segments.map((s, i) => ({
        id: `segment-${i}`,
        name: s.kind,
        startMs: s.start_s * 1000,
        endMs: s.end_s * 1000,
      })),
    };
  };
  return [
    ...['cam-parka', 'cam-tshirt'].map((id) => ({
      id,
      file: `data/reference-photos/FB7675-100-parka-trang/video/${id}.mp4`,
      segments: [
        {
          id: 'nominal-still',
          name: 'still',
          startMs: id === 'cam-parka' ? 1500 : 1200,
          endMs: 4500,
        },
      ],
    })),
    stock(cross, 'stock-cross'),
    stock(dark, 'stock-dark'),
  ];
}

export function quickDeltas(rows, baseline) {
  return rows.map((r) => {
    const previous = baseline?.rows?.find((b) => b.clip === r.clip && b.style === r.style);
    return {
      clip: r.clip,
      style: r.style,
      ...Object.fromEntries(
        QUICK_METRICS.map((k) => [
          k,
          Number.isFinite(r.metrics?.[k]) && Number.isFinite(previous?.metrics?.[k])
            ? r.metrics[k] - previous.metrics[k]
            : null,
        ]),
      ),
    };
  });
}

export function quickTable(rows, delta = false) {
  const fmt = (v) => (Number.isFinite(v) ? v.toFixed(3) : 'N/A');
  return [
    '| clip | product | still px/camera | rot RMS deg | scale p95 % | onset camera frames | residual px | uncovered % | kiosk AR fps | processing proxy ms | status |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${r.clip} | ${r.style} | ${QUICK_METRICS.map((k) => fmt(delta ? r[k] : r.metrics?.[k])).join(' | ')} | ${delta ? 'delta' : r.complete ? 'sampled; visual review pending' : 'INCOMPLETE'} |`,
    ),
  ].join('\n');
}
