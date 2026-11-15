// Extras LiveAvatar hands to the deformers beyond the lead's contract (contract.ts
// LiveGarmentBinding / LiveDeformContext). Optional: a deformer that does not need them (V7's
// pose correctives) ignores them; the dynamics deformer needs `body` for its collisions.
import type { LiveDeformContext, LiveGarmentBinding } from '../contract.ts';

/** Body-region flags per body vertex (bit set = a particle of that kind may anchor on it). */
export const BODY_TRUNK = 1; // arm weight below TORSO_LIMB_WEIGHT_MAX: trunk, neck, head, legs
export const BODY_ARM_L = 2; // left-arm weight at least SLEEVE_ARM_WEIGHT_MIN
export const BODY_ARM_R = 4;

export type DeformBody = {
  /** Body vertex positions at the bind (neutral) pose, V·3, scene metres. */
  neutral: Float32Array;
  /** BODY_* flags per body vertex. */
  regions: Uint8Array;
};

export type LiveGarmentBindingExt = LiveGarmentBinding & { body?: DeformBody };

export type LiveDeformContextExt = LiveDeformContext & {
  /** Posed body vertex normals (V·3), same frame as bodyPositions; read-only. */
  bodyNormals?: Float32Array;
};

export type DeformStatus = {
  name: string;
  active: boolean;
  note: string;
  lastApplyMs: number;
};
