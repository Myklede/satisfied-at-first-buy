// Fit Lab constants (agent FL, prompt 31). Every value here either copies the kiosk's own input
// (so the Fit Lab and the kiosk compute the same fit for the same body) or is a display choice
// that never changes a fit number. Sources are given per constant.
import type { FitRequest } from '../../api';
import type { JacketId, SizeLabel } from '../contract';

/**
 * The kiosk's attract/reference body input: apps/web/src/kiosk/KioskApp.tsx `REFERENCE`
 * ("the 172 cm / 65 kg male reference input (README), never a person"). Used only when the Studio
 * hands the Fit Lab no person; the panel then says on screen that it is the reference body.
 */
export const REFERENCE_PERSON = { height_cm: 172, weight_kg: 65, sex: 'male' as const };

/** The kiosk's fit defaults (KioskApp.tsx: DEFAULT_LAYER 't-shirt', preference 'regular'). */
export const KIOSK_LAYER_PRESET = 't-shirt';
export const KIOSK_PREFERENCE = 'regular';
/** Shape reference the kiosk sends (KioskApp.tsx personRequest: 'neutral'). */
export const KIOSK_SHAPE_REFERENCE: FitRequest['shape_reference'] = 'neutral';

/** The Studio's sizes (contract.ts SizeLabel), in catalogue order. */
export const STUDIO_SIZES: readonly SizeLabel[] = ['S', 'M', 'L'];

/** Contract jacket ids are the catalogue style codes (data/products/*.json `style`). */
export const JACKET_STYLES: Record<JacketId, string> = {
  'FB7675-100': 'FB7675-100',
  'DQ4920-206': 'DQ4920-206',
};

/**
 * Panel render quality (display only, never a fit number). The panel is about a third of the screen
 * beside Decart: Viewer.setQuality('Medium') caps the pixel ratio at 1 and turns the AO pass off
 * (engine/Viewer.ts); KioskMirrorView already draws only when a pose changed or every 100 ms.
 */
export const PANEL_QUALITY: 'High' | 'Medium' = 'Medium';

/**
 * Pixel size the Perception's normalised landmarks are scaled to when the Studio does not pass
 * its SharedCamera size: the Camo/laptop 1280x720 stream the team tests with (docs/requests
 * codex-sync.md gates). It only scales the engine's in-frame checks (hands/shoulders out of view),
 * never a pose angle (those come from the world landmarks) or a fit number.
 */
export const DEFAULT_FRAME_SIZE = { width: 1280, height: 720 } as const;
