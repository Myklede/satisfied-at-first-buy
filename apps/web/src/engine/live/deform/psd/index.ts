// Pose-space correctives (agent V7): the 'pose-correctives' stage of the live jacket deformer chain
// (contract.ts LiveJacketDeformer, deform/chain.ts via v7slot.ts).
import { createBrowserBaker, type BrowserBakerOptions } from './browserBaker.ts';
import { PSD } from './config.ts';
import { PoseCorrectives } from './PoseCorrectives.ts';

export { PSD, PSD_VERSION } from './config.ts';
export {
  PoseCorrectives,
  PsdNotEnabledError,
  type PsdBaker,
  type PsdProgress,
} from './PoseCorrectives.ts';
export {
  bodyIdFromKey,
  createBrowserBaker,
  productIdFromKey,
  styleAllowed,
} from './browserBaker.ts';
export type { PsdModelData } from './model.ts';

/**
 * `?psd=0` off, `?psd=1` on for every product (labs), otherwise 'auto': on for the products in
 * PSD.defaultOnStyles.
 */
export const psdRequested = (search = globalThis.location?.search ?? ''): 'on' | 'off' | 'auto' => {
  const value = new URLSearchParams(search).get('psd');
  return value === '0' ? 'off' : value === '1' ? 'on' : 'auto';
};

/** `?psdworkers=1` or `2` in the page URL (labs: the live check's tracker-cost comparison). */
export const psdWorkersRequested = (search = globalThis.location?.search ?? '') => {
  const value = Number(new URLSearchParams(search).get('psdworkers'));
  return value === 1 || value === 2 ? value : undefined;
};

/** The live 'pose-correctives' deformer, baking in Web Workers against the local body service. */
export function createPoseCorrectives(options: BrowserBakerOptions & { enabled?: boolean } = {}) {
  const mode = psdRequested();
  return new PoseCorrectives({
    baker: createBrowserBaker({
      ...options,
      styles: options.styles ?? (mode === 'on' ? 'all' : PSD.defaultOnStyles),
      workers: options.workers ?? psdWorkersRequested(),
    }),
    enabled: options.enabled ?? mode !== 'off',
  });
}
