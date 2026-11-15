import { PerspectiveCamera, Vector3 } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export type Preset = 'front' | 'back' | 'shoulder' | 'side' | 'shoulders';
export function presetPose(preset: Preset, height: number) {
  const poses = {
    front: { position: [0, height * 0.56, height * 1.85], target: [0, height * 0.52, 0] },
    back: { position: [0, height * 0.56, -height * 1.85], target: [0, height * 0.52, 0] },
    shoulder: {
      position: [height * 0.4, height * 0.95, height * 0.85],
      target: [0, height * 0.81, 0],
    },
    side: { position: [height * 1.85, height * 0.56, 0], target: [0, height * 0.52, 0] },
    shoulders: { position: [0, height * 0.92, -height * 0.95], target: [0, height * 0.8, 0] },
  };
  return poses[preset];
}

export class CameraRig {
  height = 1.72;
  private destination?: {
    fromPosition: Vector3;
    fromTarget: Vector3;
    position: Vector3;
    target: Vector3;
    elapsed: number;
  };
  private motionPreference =
    typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : undefined;
  constructor(
    private camera: PerspectiveCamera,
    private controls: OrbitControls,
  ) {
    controls.addEventListener('start', this.cancel);
  }
  private cancel = () => {
    this.destination = undefined;
  };
  preset(preset: Preset) {
    this.moveTo(presetPose(preset, this.height));
  }
  /** A small dolly into the real dressed result, before the later shoulder X-ray preset. */
  enterResult() {
    const pose = presetPose('front', this.height);
    pose.position[2] *= 0.94; // Presentation framing only; no fit or measurement changes.
    this.moveTo(pose);
  }
  private moveTo(pose: ReturnType<typeof presetPose>) {
    this.destination = {
      fromPosition: this.camera.position.clone(),
      fromTarget: this.controls.target.clone(),
      position: new Vector3(...pose.position),
      target: new Vector3(...pose.target),
      elapsed: 0,
    };
    if (this.motionPreference?.matches) this.update(0);
  }
  update(dt: number) {
    const d = this.destination;
    if (!d) return;
    // Fixed 0.85 s UI move; smoothstep starts and ends at rest, independent of frame rate.
    d.elapsed += Math.max(0, dt);
    const t = this.motionPreference?.matches ? 1 : Math.min(1, d.elapsed / 0.85);
    if (t === 1) {
      this.camera.position.copy(d.position);
      this.controls.target.copy(d.target);
      this.destination = undefined;
      return;
    }
    const eased = t * t * (3 - 2 * t);
    this.camera.position.lerpVectors(d.fromPosition, d.position, eased);
    this.controls.target.lerpVectors(d.fromTarget, d.target, eased);
  }
  dispose() {
    this.controls.removeEventListener('start', this.cancel);
  }
}
