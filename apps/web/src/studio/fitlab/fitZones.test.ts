import { describe, expect, it } from 'vitest';
import type { ClothAsset, GarmentSpec, SizeFit } from '../../api';
import { assignZones, FIT_ZONES, NO_ZONE, rankNotes, zoneStates } from './fitZones';

type Zone = SizeFit['zones'][string];
const zone = (
  metric: string,
  value: number | null,
  status: Zone['status'],
  design?: number,
): Zone => ({
  value_cm: value,
  metric,
  status,
  explanation: '',
  estimated: false,
  design_ease_cm: design ?? null,
});
// Test inputs shaped like the engine's response (not product data).
const size = (collar: Zone): SizeFit =>
  ({
    size: 'S',
    zones: {
      chest: zone('inner_ease_cm', 1.5, 'tight', 10.6),
      hem: zone('inner_ease_cm', -2.7, 'tight', 10.6),
      bicep: zone('inner_ease_cm', 3, 'fit', 4),
      shoulder: zone('shoulder_offset_cm', 1, 'fit'),
      sleeve: zone('sleeve_offset_cm', 8.6, 'too_big'),
      collar,
    },
  }) as unknown as SizeFit;
const product = {
  sizes: { S: { collar_inner: { value_cm: 35, source: 'tape_measured', source_detail: '' } } },
} as unknown as Pick<GarmentSpec, 'sizes'>;

describe('Fit X-ray zone states (engine numbers only)', () => {
  it('collar constrains the neck only when zipped to the top', () => {
    const fit = size(zone('collar_inner_ease_cm', -1.5, 'tight'));
    const open = zoneStates(fit, product, 'S', false).find((z) => z.zone === 'collar')!;
    expect(open.tone).toBe('none');
    expect(open.note).toMatch(/Collar open: no neck constraint/);
    const zipped = zoneStates(fit, product, 'S', true).find((z) => z.zone === 'collar')!;
    expect(zipped.tone).toBe('tight');
    // neck = collar inner − ease = 35 − (−1.5) = 36.5 (the engine's own definition)
    expect(zipped.note).toBe(
      'Collar tight when fully zipped: collar 35.0 cm vs your neck ~36.5 cm (ease −1.5 cm).',
    );
    // Ranked by the engine's numbers: hem −2.7 is tighter than collar −1.5.
    expect(
      rankNotes(zoneStates(fit, product, 'S', true))
        .map((z) => z.zone)
        .slice(0, 2),
    ).toEqual(['hem', 'collar']);
  });

  it('a positive but snug collar ease (engine status tight) is orange, not red', () => {
    const z = zoneStates(size(zone('collar_inner_ease_cm', 1.5, 'tight')), product, 'S', true);
    const collar = z.find((s) => s.zone === 'collar')!;
    expect(collar.tone).toBe('snug');
    expect(collar.note).toMatch(/snug when fully zipped: collar 35.0 cm vs your neck ~33.5 cm/);
  });

  it('unmeasured collar says so, never a guess', () => {
    const z = zoneStates(size(zone('collar_inner_ease_cm', null, 'unknown')), product, 'M', true);
    const collar = z.find((s) => s.zone === 'collar')!;
    expect(collar.tone).toBe('none');
    expect(collar.note).toMatch(/not measured/);
  });

  it('ranks tight girth zones above too-big lengths; good zones untinted', () => {
    const ranked = rankNotes(
      zoneStates(size(zone('collar_inner_ease_cm', null, 'unknown')), product, 'S', true),
    );
    expect(ranked.map((z) => z.zone).slice(0, 3)).toEqual(['hem', 'chest', 'sleeve']);
    expect(ranked.find((z) => z.zone === 'hem')!.note).toBe(
      'Hem/hip tight: ease −2.7 cm; design ease 10.6 cm.',
    );
    expect(ranked.find((z) => z.zone === 'bicep')!.tone).toBe('none');
  });

  it('maps panels and landmark bands to zones', () => {
    // particles: collar, yoke, chest (front at bust height), hem (front below hip), cuff, bicep, plain sleeve
    const initial = [
      0, 1.5, 0, 0, 1.4, 0, 0, 1.25, 0.1, 0, 0.85, 0.1, 0.6, 1.0, 0, 0.3, 1.3, 0, 0.45, 1.2, 0,
    ];
    const asset = {
      initial,
      panels: [6, 3, 0, 1, 4, 4, 4],
      landmarks: { cuff_L: 4 },
      paths: { bicep_L: [5] },
      body_landmarks: {
        bust_L: [0.1, 1.25, 0.1],
        bust_R: [-0.1, 1.25, 0.1],
        hip_level: [0, 0.9, 0],
      },
    } as unknown as ClothAsset;
    const z = Array.from(assignZones(asset)).map((i) => (i === NO_ZONE ? '-' : FIT_ZONES[i]));
    expect(z).toEqual(['collar', 'shoulder', 'chest', 'hem', 'sleeve', 'bicep', '-']);
  });
});
