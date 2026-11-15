// Shared contract for the Studio page (lead, 2026-11-15, Decart pivot).
// Decart renders the photoreal look; OUR engine owns fit, the body model and the physics.
// Agents: DC (shell, camera, Decart), FL (Fit Lab panel), ZB (perception + zip/hood bridge).
// Change this file only through the lead (post a request in docs/requests/codex-sync.md).

export type JacketId = 'FB7675-100' | 'DQ4920-206';
export type SizeLabel = 'S' | 'M' | 'L';

/** The one garment state every view follows. zip: 0 = fully closed, 1 = fully open (continuous,
 *  from the cloth solver's slider). hemPull: 0 = untouched, 1 = full pull (optional feature). */
export interface GarmentState {
  jacket: JacketId;
  size: SizeLabel;
  zip: number;
  hoodOn: boolean;
  hemPull: number;
}

export type StateSource = 'pinch' | 'slider' | 'ui' | 'system';

/** Tiny synchronous store. Implemented by DC in `studio/bus.ts`. */
export interface StudioBus {
  get(): GarmentState;
  set(patch: Partial<GarmentState>, source: StateSource): void;
  /** Called after every change with the new and previous state. Returns an unsubscribe. */
  subscribe(fn: (next: GarmentState, prev: GarmentState, source: StateSource) => void): () => void;
}

/** One camera for everything: Decart gets `stream`, our trackers read `video`. Owned by DC. */
export interface SharedCamera {
  stream: MediaStream;
  video: HTMLVideoElement;
  /** Source frame size in px (for mapping normalised landmarks to the screen). */
  width: number;
  height: number;
}

/** Normalised image landmark (0..1, origin top-left of the camera frame, NOT mirrored). */
export interface Landmark2D {
  x: number;
  y: number;
  visibility?: number;
}

/** Pose + hands from @satisfy/vision on the shared video. Implemented by ZB in
 *  `studio/perception.ts`; FL consumes `onPose`, ZB's bridge consumes `onHands`. */
export interface Perception {
  start(camera: SharedCamera): Promise<void>;
  stop(): void;
  /** 33 MediaPipe pose landmarks (image space) + world landmarks (metres) when available. */
  onPose(fn: (frame: { timeMs: number; image: Landmark2D[]; world?: { x: number; y: number; z: number }[] }) => void): () => void;
  /** Hands with a pinch flag, image space. */
  onHands(fn: (frame: { timeMs: number; hands: { handedness: 'Left' | 'Right'; points: Landmark2D[]; pinching: boolean; pinchPoint: Landmark2D }[] }) => void): () => void;
}

/** The Fit Lab side panel (FL). Plain class, framework-agnostic. */
export interface FitLabPanel {
  mount(host: HTMLElement, deps: { bus: StudioBus; perception: Perception }): Promise<void>;
  /** Visual mode inside the panel. */
  setMode(mode: 'xray' | 'heatmap' | 'look'): void;
  /** Fit verdict for the current jacket in every size, computed by our engine (never invented). */
  verdict(): FitVerdict | null;
  dispose(): void;
}

export interface FitVerdict {
  jacket: JacketId;
  recommended: SizeLabel;
  /** Per size: ease (garment minus body, cm) at the key regions; negative = tight. */
  sizes: Record<SizeLabel, { chest: number; /** Garment hem minus hip girth (cm); jackets have no waist zone. */ hem: number; shoulder: number; sleeve: number; label: 'tight' | 'good' | 'loose' }>;
}

/** Discrete zip stage for Decart, with hysteresis so a hovering pull does not flicker the render. */
export type ZipStage = 'closed' | 'half' | 'open';
export const ZIP_STAGE_ENTER = { half: 0.25, open: 0.7 } as const;
export const ZIP_STAGE_EXIT = { half: 0.15, open: 0.6 } as const;

export function zipStage(zip: number, previous: ZipStage): ZipStage {
  if (previous === 'open') return zip < ZIP_STAGE_EXIT.open ? (zip < ZIP_STAGE_EXIT.half ? 'closed' : 'half') : 'open';
  if (previous === 'half') {
    if (zip >= ZIP_STAGE_ENTER.open) return 'open';
    return zip < ZIP_STAGE_EXIT.half ? 'closed' : 'half';
  }
  if (zip >= ZIP_STAGE_ENTER.open) return 'open';
  return zip >= ZIP_STAGE_ENTER.half ? 'half' : 'closed';
}
