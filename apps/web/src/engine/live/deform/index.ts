// Live jacket deformers (contract.ts "Live jacket deformers"): the chain LiveAvatar runs after the
// LBS skinning. deform/psd/** is agent V7's; the rest is agent V6's.
export { DYNAMICS, physicalParameters } from './config.ts';
export {
  createLiveDeformers,
  DeformerChain,
  DEFORMER_ORDER,
  type DeformerName,
  type LiveDeformerOptions,
} from './chain.ts';
export {
  createDynamics,
  DynamicsDeformer,
  type DynamicsFrameStats,
  type DynamicsDeformerOptions,
} from './DynamicsDeformer.ts';
export { bodyRegions } from './body.ts';
export { plausibleHeading, rootYawFromWorld, wrapDeg, YawFilter } from './heading.ts';
export type {
  DeformBody,
  DeformStatus,
  LiveDeformContextExt,
  LiveGarmentBindingExt,
} from './types.ts';
