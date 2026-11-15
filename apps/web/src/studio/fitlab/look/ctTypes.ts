// CT stage contract (lead, 2026-11-15 06:08). Wheel: Look (reveal 0) -> see-through (reveal 1)
// -> keep scrolling -> CT stage (phase 0..1): the camera tilts from the front view down to an
// oblique top view of the cut, everything above the slice plane is clipped away, and the cut is
// drawn in 3D. Owners: CT = SliceView (slice data), CS = stage driver (wheel, camera, clipping,
// wiring), CL = ctCap.ts (3D cut caps), VX = ctScanner.ts (scanner visuals + 3D gap callouts).
// Change only through the lead (post in docs/requests/codex-sync.md).
import type { PerspectiveCamera, Raycaster, Vector3 } from 'three';
import type { SizeLabel } from '../../contract';
import type { CutPoint, Loop } from './crossSection';

export type CtTone = 'tight' | 'snug' | null;

/** One slice, in world space (metres, Y-up, +Z = body front). Produced by CT's SliceView. */
export interface CtSlice {
  /** World height of the slice plane. */
  y: number;
  /** Centre of the body cut (x, z). */
  centre: { x: number; z: number };
  /** Body cut loops (closed). */
  body: readonly Loop[];
  /** Selected size's shell cut loops (open "C" when the zip is open). */
  shell: readonly Loop[];
  /** The other preloaded sizes' shell cuts (ghosts). */
  ghosts: readonly { size: SizeLabel; loops: readonly Loop[] }[];
  /** Engine gap in cm at a shell cut point (the mesh's `_inner_gap_cm`), null when unknown. */
  gapAt(p: CutPoint): number | null;
  /** Engine tone of a shell segment's fit zone (Loop.zones[i]); only tight/snug are tinted. */
  toneOf(zone: number): CtTone;
  /** true = the physics solver's shell; false = the LBS preview (label gaps "preview"). */
  solver: boolean;
  selectedSize: SizeLabel;
}

/** A visual layer of the CT stage. phase 0 = see-through (layer hidden), 1 = full CT view. */
export interface CtLayer {
  update(phase: number, slice: CtSlice | null, camera: PerspectiveCamera): void;
  dispose(): void;
}

// ---- v2 (lead, 06:12, the user's refined spec) -------------------------------------------
// Keep scrolling past see-through: the camera turns smoothly to the RIGHT (orbit about +60 deg,
// slight elevation ~20 deg). A STACK of CT layers (horizontal cuts from hem to collar) slides
// out of the body, one layer after another, and floats beside it facing the viewer. Hovering a
// layer lights it softly and shows its info (engine numbers). Scrolling back reverses: layers
// return into the body, camera turns back to the straight see-through view, then zooms out to
// the Look. No clipping in v2.

/** Several slices, bottom (hem) to top (collar). Produced by CT's SliceView.stack(n). */
export interface CtStack {
  slices: readonly CtSlice[];
  /** 'Collar' | 'Chest' | 'Hem' where a layer sits on an engine zone anchor, '' otherwise. */
  labels: readonly string[];
  /** Engine verdict line of the zone each layer crosses (FL's notes), '' when none. */
  verdicts: readonly string[];
}

/** A visual layer of the v2 stage. phase 0 = see-through (hidden), 1 = all layers out. */
export interface CtStackLayer {
  update(phase: number, stack: CtStack | null, camera: PerspectiveCamera): void;
  dispose(): void;
}

/** CL's caps expose picking so VX can do hover (CS wires VX with CL's instance). */
export interface CtPickable {
  /** Index of the layer disc under the ray at its current (slid-out) position, or null. */
  pick(raycaster: Raycaster): number | null;
  /** Soft glow on one layer (null = none). */
  setHover(index: number | null): void;
  /** Current world centre of layer i's disc (for the info card / leader line), null if hidden. */
  layerCentre(i: number, out: Vector3): Vector3 | null;
}
