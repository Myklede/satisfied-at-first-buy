// V7 SLOT. Agent V7 owns the one code line below and may replace it, e.g. with
//   export { createPoseCorrectives } from './psd/index.ts';
// It is the 'pose-correctives' factory the chain (chain.ts) runs first, before 'dynamics'.
// null = no pose correctives yet: the chain skips the stage.
export { createPoseCorrectives } from './psd/index.ts';
