// Fit Lab entry for the Studio shell (DC's main.ts loads `createFitLabPanel`).
import type { FitLabPanel } from '../contract';
import { FitLab, type FitLabOptions } from './FitLabPanel';

export { FitLab } from './FitLabPanel';
export type {
  FitLabInteractHost,
  FitLabMode,
  FitLabOptions,
  FitLabPerson,
  FitLabStatus,
} from './FitLabPanel';
export type { FitLabVerdict, SizeVerdict } from './verdict';

/** The Studio's Fit Lab panel. The returned object is a FitLab (interactHost(), pauseLive(), …). */
export function createFitLabPanel(options?: FitLabOptions): FitLabPanel & FitLab {
  return new FitLab(options);
}
