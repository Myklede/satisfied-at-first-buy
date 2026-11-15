// Exports P3's reference forward kinematics (packages/vision/src/poseSynth.ts, read-only) for
// a set of AnatomicalPoses, so the Python rig can be cross-checked against the same numbers.
// Output: services/body/body_service/motion/p3_reference.json (segment unit directions in
// P3's body frame: X forward, Y up, Z subject's right).
// Run: node scripts/motion-p3-reference.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// packages/vision is bundler-style TypeScript (extension-less imports, parameter
// properties), so transpile it with the repo's own `typescript` and resolve "<spec>.ts".
const ts = createRequire(import.meta.url)('typescript');
registerHooks({
  load(url, context, next) {
    if (!url.endsWith('.ts')) return next(url, context);
    const source = readFileSync(fileURLToPath(url), 'utf8');
    const { outputText } = ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    return { format: 'module', source: outputText, shortCircuit: true };
  },
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (specifier.startsWith('.') && !specifier.endsWith('.ts')) {
        return next(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});
const { poseSkeleton } = await import('../packages/vision/src/poseSynth.ts');

const both = (prefix, value) => ({
  [prefix.replace('{s}', 'L')]: value,
  [prefix.replace('{s}', 'R')]: value,
});
const zero = {
  trunk_flexion: 0,
  trunk_lateral: 0,
  trunk_twist: 0,
  ...both('shoulder_{s}_plane', 0),
  ...both('shoulder_{s}_elevation', 0),
  ...both('shoulder_{s}_axial', 0),
  ...both('elbow_{s}_flexion', 0),
  ...both('hip_{s}_flexion', 0),
  ...both('knee_{s}_flexion', 0),
  pelvis_drop_m: 0,
};
const poses = [
  { ...both('shoulder_{s}_elevation', 30), ...both('elbow_{s}_flexion', 20) },
  {
    ...both('shoulder_{s}_plane', 40),
    ...both('shoulder_{s}_elevation', 170),
    ...both('elbow_{s}_flexion', 10),
  },
  {
    ...both('shoulder_{s}_plane', 90),
    ...both('shoulder_{s}_elevation', 80),
    ...both('elbow_{s}_flexion', 25),
  },
  {
    shoulder_L_plane: 125,
    shoulder_L_elevation: 45,
    shoulder_L_axial: -40,
    elbow_L_flexion: 125,
    shoulder_R_plane: -60,
    shoulder_R_elevation: 50,
    shoulder_R_axial: 30,
    elbow_R_flexion: 60,
  },
  {
    trunk_flexion: 90,
    ...both('hip_{s}_flexion', 15),
    ...both('knee_{s}_flexion', 30),
    ...both('shoulder_{s}_plane', 90),
    ...both('shoulder_{s}_elevation', 100),
    ...both('elbow_{s}_flexion', 10),
  },
  { trunk_flexion: 10, ...both('hip_{s}_flexion', 90), ...both('knee_{s}_flexion', 90) },
  {
    trunk_lateral: -10,
    trunk_twist: 20,
    shoulder_R_plane: 40,
    shoulder_R_elevation: 175,
    shoulder_L_plane: 10,
    shoulder_L_elevation: 60,
    shoulder_L_axial: 45,
    elbow_L_flexion: 90,
  },
  {
    trunk_flexion: 30,
    trunk_lateral: 15,
    trunk_twist: -30,
    hip_L_flexion: 40,
    knee_L_flexion: 70,
    shoulder_L_plane: 0,
    shoulder_L_elevation: 90,
    shoulder_L_axial: -60,
    elbow_L_flexion: 90,
  },
].map((p) => ({ ...zero, ...p }));

const unit = (a, b) => {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const n = Math.hypot(...d);
  return d.map((x) => x / n);
};
const segments = {
  trunk: ['midHip', 'midShoulder'],
  shoulder_line: ['lShoulder', 'rShoulder'],
  humerus_L: ['lShoulder', 'lElbow'],
  humerus_R: ['rShoulder', 'rElbow'],
  forearm_L: ['lElbow', 'lWrist'],
  forearm_R: ['rElbow', 'rWrist'],
  thigh_L: ['lHip', 'lKnee'],
  thigh_R: ['rHip', 'rKnee'],
  shank_L: ['lKnee', 'lAnkle'],
  shank_R: ['rKnee', 'rAnkle'],
};
const cases = poses.map((pose) => {
  const sk = poseSkeleton(pose);
  const directions = Object.fromEntries(
    Object.entries(segments).map(([name, [a, b]]) => [name, unit(sk[a], sk[b])]),
  );
  return { pose, directions };
});
const out = resolve('services/body/body_service/motion/p3_reference.json');
writeFileSync(
  out,
  JSON.stringify(
    {
      source: 'packages/vision/src/poseSynth.ts poseSkeleton (P3 reference FK)',
      frame: 'P3 body frame: X forward, Y up, Z subject right',
      cases,
    },
    null,
    1,
  ) + '\n',
);
console.log(`wrote ${cases.length} cases to ${out}`);
