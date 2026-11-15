import { z } from 'zod';
import type { components } from '@satisfy/api-types';
import { measuredJson, recordTiming, timingEnabled } from './engine/requestTiming';

export type FitRequest = components['schemas']['FitRequest'];
export type FitResponse = components['schemas']['FitResponse'];
export type Landmarks = components['schemas']['LandmarkResponse'];
export type Capabilities = components['schemas']['CapabilitiesResponse'];
export type KnownMeasurements = components['schemas']['KnownMeasurements'];
export type Uncertainty = components['schemas']['UncertaintyResponse'];
export type GarmentSpec = components['schemas']['GarmentSpec'];
export type GarmentFitRequest = components['schemas']['GarmentFitRequest'];
export type GarmentFitResponse = components['schemas']['GarmentFitResponse'];
export type GarmentOptions = components['schemas']['GarmentOptions'];
export type SizeFit = components['schemas']['SizeFit'];
export type ZoneMetric = components['schemas']['ZoneMetric'];
export type ClothAsset = components['schemas']['ClothAsset'];

const finite = z.number().finite();
const point = z.tuple([finite, finite, finite]);
const dictionary = <T extends z.ZodType>(schema: T) => z.record(z.string(), schema);
const bandSchema = z.strictObject({
  lower_cm: finite,
  upper_cm: finite,
  accepted_samples: z.number().int().nonnegative(),
  attempted_samples: z.number().int().positive(),
  method: z.string(),
});
const uncertaintySchema: z.ZodType<Uncertainty> = z.strictObject({
  bands: dictionary(bandSchema.nullable()),
  accepted_samples: z.number().int().nonnegative(),
  attempted_samples: z.number().int().positive(),
  compute_ms: finite.nonnegative(),
  note: z.string(),
});
export const fitSchema: z.ZodType<FitResponse> = z
  .strictObject({
    body_id: z.string().regex(/^[a-f0-9]{64}$/),
    phenotypes: dictionary(finite.min(0).max(1)),
    local_changes: dictionary(finite.min(-1).max(1)),
    measurements: dictionary(
      z.strictObject({
        value_cm: finite.positive(),
        method: z.string(),
        uncertainty: bandSchema.nullable().optional(),
      }),
    ),
    mass_kg: finite.positive(),
    volume_m3: finite.positive(),
    density_kg_m3: z.union([z.literal(980), z.literal(1010)]),
    targets: dictionary(finite),
    residuals: dictionary(finite),
    fit_ms: finite.nonnegative(),
    converged: z.boolean(),
    warnings: z.array(z.string()),
  })
  .superRefine((data, context) => {
    for (const name of [
      'stature',
      'chest',
      'waist',
      'hip',
      'neck_base',
      'upper_arm',
      'wrist',
      'shoulder_width',
      'shoulder_arc',
      'arm_length',
      'back_length',
    ]) {
      if (!data.measurements[name])
        context.addIssue({ code: 'custom', message: `Missing measurement: ${name}` });
    }
    for (const name of ['stature', 'mass_kg']) {
      if (!(name in data.targets) || !(name in data.residuals))
        context.addIssue({ code: 'custom', message: `Missing target/residual: ${name}` });
    }
  });
export const landmarksSchema: z.ZodType<Landmarks> = z.strictObject({
  coordinate_frame: z.literal('metres Y-up +Z-front A-pose'),
  landmarks: dictionary(point),
  girth_polylines: dictionary(z.array(point).min(3)),
});
export const capabilitiesSchema: z.ZodType<Capabilities> = z.strictObject({
  phenotype_labels: z.array(z.string()),
  shape_reference_supported: z.boolean(),
  shape_references: z.array(z.enum(['neutral', 'african', 'asian', 'caucasian'])),
  measurements: z.array(z.string()),
  default_density_kg_m3: z.union([z.literal(980), z.literal(1010)]),
});
const sourced = z.strictObject({
  value_cm: finite.positive().nullable().optional(),
  min_cm: finite.positive().nullable().optional(),
  max_cm: finite.positive().nullable().optional(),
  source: z.enum(['tape_measured', 'retailer_chart', 'web_lookup', 'derived_grading']),
  source_detail: z.string(),
  uncertainty_cm: finite.nonnegative().nullable().optional(),
});
const visualFact = z.strictObject({
  value: z.string(),
  source: z.enum(['retailer_copy', 'photo_estimate', 'model_assumption']),
  approximate: z.boolean(),
  source_detail: z.string(),
});
const visualMeasure = z.strictObject({
  value_cm: finite.positive(),
  source: z.enum(['retailer_copy', 'photo_estimate', 'model_assumption']),
  approximate: z.boolean(),
  uncertainty_cm: finite.nonnegative(),
  source_detail: z.string(),
});
const visualSchema = z.strictObject({
  quilting: visualFact,
  chamber_height: visualMeasure,
  chamber_width: visualMeasure.nullable().optional(),
  yoke_depth: visualMeasure,
  sleeve_chamber_height: visualMeasure,
  hood: visualFact,
  hood_features: z.array(visualFact),
  front: visualFact,
  storm_flap_width: visualMeasure.nullable().optional(),
  pockets: visualFact,
  pocket_top: visualMeasure.nullable().optional(),
  pocket_length: visualMeasure.nullable().optional(),
  cuffs: visualFact,
  hem: visualFact,
  finish: visualFact,
  colour_hex: visualFact,
  logo: z.literal('omitted'),
});
const garmentSize = z
  .strictObject(
    Object.fromEntries(
      [
        'shoulder',
        'chest',
        'hem',
        'length_hps',
        'length_back',
        'sleeve',
        'bicep',
        'sleeve_cb',
        'chest_inner',
        'hem_inner',
        'collar_inner',
        'collar_height',
      ].map((key) => [key, sourced.nullable().optional()]),
    ),
  )
  .superRefine((size, context) => {
    const inner = size.collar_inner,
      height = size.collar_height;
    if ((inner != null) !== (height != null)) {
      context.addIssue({
        code: 'custom',
        path: ['collar_inner'],
        message: 'Collar inner circumference and height must be measured together',
      });
    }
    // Match GarmentSize's collar-only rules; legacy garment tapes keep their schema.
    for (const [field, tape, min, max] of [
      ['collar_inner', inner, 10, 100],
      ['collar_height', height, 1, 30],
    ] as const) {
      if (tape == null) continue;
      const value = tape.value_cm;
      if (
        tape.source !== 'tape_measured' ||
        typeof value !== 'number' ||
        value < min ||
        value > max ||
        tape.min_cm != null ||
        tape.max_cm != null ||
        (tape.uncertainty_cm != null && tape.uncertainty_cm >= value)
      ) {
        context.addIssue({
          code: 'custom',
          path: [field],
          message: `Collar tape must be an exact measured value in ${min}–${max} cm with uncertainty below the value`,
        });
      }
    }
  });
export const productSchema: z.ZodType<GarmentSpec> = z.strictObject({
  product_id: z.string().regex(/^[a-f0-9]{64}$/),
  url: z.url(),
  brand: z.string(),
  category: z.literal('jacket'),
  chart_type: z.enum(['garment', 'body']),
  unit: z.literal('cm'),
  owned_size: z.string().nullable().optional(),
  sizes: dictionary(garmentSize),
  fabric: z.strictObject({
    composition: z.string(),
    elastane_pct: finite.nullable().optional(),
    stretch_max: finite.nullable().optional(),
  }),
  notes: z.string(),
  title: z.string(),
  style: z.string(),
  colourway: z.string(),
  url_aliases: z.array(z.url()).optional(),
  construction: z.enum(['set_in', 'drop_shoulder', 'raglan']),
  fit_intent: z.enum(['slim', 'regular', 'loose', 'oversized']),
  loft_cm: finite.nullable().optional(),
  loft_uncertainty_cm: finite,
  hem_elastic: z.boolean(),
  body_chart_type: z.literal('body'),
  body_chart: dictionary(
    z.strictObject({
      chest: sourced.nullable().optional(),
      waist: sourced.nullable().optional(),
      hip: sourced.nullable().optional(),
    }),
  ).optional(),
  visual: visualSchema.nullable().optional(),
});
export const garmentFitSchema: z.ZodType<GarmentFitResponse> = z.strictObject({
  fit_id: z.string().regex(/^[a-f0-9]{64}$/),
  body_id: z.string().regex(/^[a-f0-9]{64}$/),
  product_id: z.string().regex(/^[a-f0-9]{64}$/),
  sizes: dictionary(
    z.strictObject({
      size: z.string(),
      zones: dictionary(
        z.strictObject({
          value_cm: finite.nullable().optional(),
          lower_cm: finite.nullable().optional(),
          upper_cm: finite.nullable().optional(),
          metric: z.string(),
          status: z.enum(['tight', 'fit', 'relaxed', 'too_big', 'unknown']),
          explanation: z.string(),
          estimated: z.boolean(),
          design_ease_cm: finite.nullable().optional(),
          position_vs_hip_cm: finite.nullable().optional(),
        }),
      ),
      score: finite.nullable(),
      coverage: finite.min(0).max(1),
      estimated: z.boolean(),
      geometry_available: z.boolean(),
      missing_fields: z.array(z.string()),
      anchors: dictionary(point),
      polylines: dictionary(z.array(point)),
      warnings: z.array(z.string()),
      build_ms: finite.nullable().optional(),
      elastic_zones: z.array(z.string()).optional(),
    }),
  ),
  recommended_size: z.string().nullable(),
  comparison_zones: z.array(z.string()).optional(),
  explanation: z.string(),
  layer_cm: finite,
  preference: z.string(),
  loft_cm: finite.nullable(),
  loft_uncertainty_cm: finite,
  heatmap_tight_cm: finite,
  heatmap_loose_cm: finite,
  note: z.string(),
});
const optionsSchema: z.ZodType<GarmentOptions> = z.strictObject({
  layer_presets_cm: dictionary(finite),
  preferences: z.array(z.string()),
});
const indices = z.array(z.number().int().min(0).max(100000)).max(300000);
const scalars = z.array(finite).max(100000);
const apertureSchema = z.strictObject({
  path: z.array(point),
  distances_m: scalars,
  guide_radii_m: scalars,
  stop_distance_m: finite.nullable(),
  opening_m: finite.positive(),
  fits_minimum_section: z.boolean(),
  source: z.string(),
});
export const clothSchema: z.ZodType<ClothAsset> = z
  .strictObject({
    key: z.string().max(200),
    pose: z.string(),
    rest: scalars,
    initial: scalars,
    triangles: indices,
    panels: indices,
    elastic: scalars,
    stitch: scalars,
    loft: scalars,
    welds: indices,
    tethers: indices.optional(),
    tether_lengths: scalars.optional(),
    cuff_colliders: dictionary(
      z.strictObject({
        path: z.array(point),
        distances_m: scalars,
        guide_radii_m: scalars,
        stop_distance_m: finite.nullable(),
        opening_m: finite.positive(),
        fits_minimum_section: z.boolean(),
        source: z.string(),
      }),
    ).optional(),
    paths: dictionary(indices),
    landmarks: dictionary(z.number().int().min(0)),
    body_landmarks: dictionary(point),
    body_positions: scalars,
    body_triangles: indices,
    sdf: z.strictObject({
      sdf_id: z.string().regex(/^[a-f0-9]{64}$/),
      origin: point,
      dimensions: z.array(z.number().int().min(2).max(1000)).length(3),
      spacing: finite.min(0.005).max(0.008),
      byte_length: z.number().int().positive().max(100000000),
      distance_bias_m: finite,
    }),
    config: dictionary(finite),
    rest_measurements_cm: dictionary(finite),
    colour: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    finish: z.enum(['glossy_ripstop', 'satin_matte']),
    layer_m: finite.min(0).max(0.02),
    stretch_max_source: z.string(),
    build_ms: finite.min(0),
    warnings: z.array(z.string()).optional(),
    fabric_surface: z.enum(['outer', 'neutral']).default('outer'),
    render_offsets: scalars.optional(),
    attachments: indices.optional(),
    attachment_offsets: scalars.optional(),
    body_arm_faces: dictionary(indices).optional(),
    body_arm_routes: dictionary(z.array(point)).optional(),
    render_uv: scalars.optional(),
    quilt: scalars.optional(),
    stitch_distance_m: scalars.optional(),
    puff_frames: indices.optional(),
    puff_components: scalars.optional(),
    maximum_loft_m: finite.min(0).max(0.1).default(0),
    render_details: dictionary(finite).optional(),
    // Material (rest) arc along each sleeve; equals render_uv v elsewhere (shell.py).
    render_material_v: scalars.optional(),
    neck_collider: apertureSchema.nullable().optional(),
  })
  .superRefine((a, ctx) => {
    const n = a.rest.length / 3;
    if (
      !Number.isInteger(n) ||
      n < 1 ||
      n > 15000 ||
      a.initial.length !== a.rest.length ||
      a.panels.length !== n ||
      a.elastic.length !== n ||
      a.stitch.length !== n ||
      a.loft.length !== n ||
      (a.fabric_surface === 'neutral' &&
        (a.render_offsets?.length !== n * 3 ||
          a.render_uv?.length !== n * 2 ||
          (a.render_material_v?.length ?? n) !== n ||
          a.quilt?.length !== n * 4 ||
          a.stitch_distance_m?.length !== n ||
          a.puff_frames?.length !== n * 3 ||
          a.puff_frames.some((i) => i >= n) ||
          a.puff_components?.length !== n * 3 ||
          (a.attachments?.length ?? 0) % 4 !== 0 ||
          a.attachment_offsets?.length !== ((a.attachments?.length ?? 0) / 4) * 3 ||
          a.attachments?.some((i) => i >= n))) ||
      a.triangles.length % 3 ||
      a.triangles.some((i) => i >= n) ||
      a.sdf.byte_length !== a.sdf.dimensions.reduce((a, b) => a * b, 1) * 4 ||
      a.welds.some((i) => i >= n) ||
      Object.values(a.paths).some((p) => p.some((i) => i >= n))
    )
      ctx.addIssue({ code: 'custom', message: 'Invalid cloth topology' });
  });

async function json<T>(path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const diagnostic = timingEnabled();
  const started = diagnostic ? performance.now() : 0;
  const response = await fetch(`/api${path}`, { cache: 'no-store', ...init });
  const headersAt = diagnostic ? performance.now() : 0;
  if (!response.ok) {
    if (response.status === 404)
      throw new Error('Body expired from memory. Build your body again.');
    if (response.status === 422)
      throw new Error('These inputs could not produce a reliable body. Check your measurements.');
    throw new Error(
      `Body service unavailable (${response.status}). Check that npm run dev is running.`,
    );
  }
  const measured = diagnostic ? await measuredJson(response) : undefined;
  const validateAt = diagnostic ? performance.now() : 0;
  const result = schema.safeParse(measured ? measured.data : await response.json());
  if (measured)
    recordTiming({
      phase: 'request',
      category: path.endsWith('/cloth') ? 'cloth' : path.split('/')[1],
      atMs: started,
      values: {
        headersMs: headersAt - started,
        readMs: measured.readMs,
        decodeMs: measured.decodeMs,
        parseMs: measured.parseMs,
        validationMs: performance.now() - validateAt,
        decodedBytes: measured.bytes,
        serverTiming: response.headers.get('Server-Timing') ?? '',
      },
    });
  if (!result.success)
    throw new Error(
      'The body service returned an invalid response. Rebuild API types and restart.',
    );
  return result.data;
}
const sdfCache = new Map<string, Promise<ArrayBuffer>>();
export const api = {
  sdf: async (asset: ClothAsset) => {
    const id = asset.sdf.sdf_id;
    let pending = sdfCache.get(id);
    if (!pending) {
      pending = fetch(`/api/collision/${id}.bin`, { cache: 'no-store' }).then(async (r) => {
        if (!r.ok) throw new Error(`Collision field unavailable (${r.status})`);
        const buffer = await r.arrayBuffer();
        if (buffer.byteLength !== asset.sdf.byte_length)
          throw new Error('Collision field byte count mismatch');
        return buffer;
      });
      sdfCache.set(id, pending);
      pending.catch(() => sdfCache.delete(id));
      if (sdfCache.size > 4) sdfCache.delete(sdfCache.keys().next().value!);
    }
    return pending;
  },
  cloth: (fitId: string, size: string, signal?: AbortSignal) => {
    if (!/^[a-f0-9]{64}$/.test(fitId) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,23}$/.test(size))
      throw new Error('Invalid cloth ID');
    return json(`/fit/${fitId}/${size}/cloth`, clothSchema, { signal });
  },
  products: (signal?: AbortSignal) => json('/products', z.array(productSchema), { signal }),
  garmentOptions: (signal?: AbortSignal) => json('/garment/options', optionsSchema, { signal }),
  garmentFit: (request: GarmentFitRequest, signal?: AbortSignal) =>
    json('/fit/garment', garmentFitSchema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    }),
  capabilities: (signal?: AbortSignal) =>
    json('/body/capabilities', capabilitiesSchema, { signal }),
  fit: (request: FitRequest, signal?: AbortSignal) =>
    json('/body/fit', fitSchema, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    }),
  landmarks: (id: string, signal?: AbortSignal) => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid body ID');
    return json(`/body/${id}/landmarks`, landmarksSchema, { signal });
  },
  uncertainty: (id: string, signal?: AbortSignal) => {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Invalid body ID');
    return json(`/body/${id}/uncertainty`, uncertaintySchema, { signal });
  },
};
