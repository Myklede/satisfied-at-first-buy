// AR finishing pass (agent V4): public entry. V2's ArCompositor takes it through its ArFinisher
// seam: `compositor.finisher = new ArFinish()`.
export { ArFinish, type FinishOptions, type FinishStats } from './ArFinish';
export { fitFaceLight, type LightEstimate } from './light';
export { maskMotion, type MaskMotion } from './motion';
export { WorkerSegmenter } from './segmenterClient';
export {
  faceBox,
  finishGeometry,
  frontal,
  regionAt,
  sleeveEnd,
  upperBodyRect,
  type FinishGeometry,
} from './geometry';
