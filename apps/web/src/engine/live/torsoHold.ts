// ?f1torso=1 (agent F1, lead 21:5x; user J1: "the parka wobbles like jelly, every move it shakes").
// A stiff quilted parka's torso is near-rigid: it does not bend with every small change of the
// trunk estimate. The trunk DOFs that bend and twist the skinned jacket hold their value while
// the estimate stays within a band around it. They move (glide, time constant glideMs, following
// while the change goes on, then hold again) only for a real change:
// - a large one: beyond the band for sustainMs (a clear bend or twist);
// - a small but settled one: over the last driftMs the estimate stayed within the band of itself
//   and its mean sits more than driftDeg from the held value (so a turn that ends 8 deg short of
//   neutral does not leave the jacket twisted for good; noise around the held value averages out).
// Frame-to-frame noise never reaches the jacket. Constants: ar/config.ts TORSO.
import type { AnatomicalPose } from '../motion/rig.ts';
import { TORSO } from './ar/config.ts';

type DofState = {
  held: number;
  since?: number;
  moving: boolean;
  t: number;
  recent: { t: number; x: number }[];
};

type TorsoParams = Pick<
  typeof TORSO,
  'bandDeg' | 'sustainMs' | 'glideMs' | 'settleDeg' | 'driftMs' | 'driftDeg'
>;

export class TorsoHold {
  private state = new Map<string, DofState>();
  constructor(private readonly p: TorsoParams = TORSO) {}

  reset() {
    this.state.clear();
  }

  /** `pose` with its trunk DOFs held (config TORSO.bandDeg); other DOFs unchanged. */
  apply(t: number, pose: AnatomicalPose): AnatomicalPose {
    let out: AnatomicalPose | null = null;
    for (const [dof, band] of Object.entries(this.p.bandDeg)) {
      const x = pose[dof];
      if (x === undefined || !Number.isFinite(x)) continue;
      const s = this.state.get(dof);
      if (!s || t < s.t) {
        this.state.set(dof, { held: x, moving: false, t, recent: [{ t, x }] });
        continue;
      }
      const dt = Math.max(0, t - s.t);
      s.t = t;
      s.recent.push({ t, x });
      while (s.recent.length > 2 && t - s.recent[1].t >= this.p.driftMs) s.recent.shift();
      if (!s.moving) {
        if (Math.abs(x - s.held) > band) {
          s.since ??= t;
          if (t - s.since >= this.p.sustainMs) s.moving = true;
        } else {
          s.since = undefined;
          const xs = s.recent.map((r) => r.x);
          const settled =
            t - s.recent[0].t >= this.p.driftMs && Math.max(...xs) - Math.min(...xs) <= band;
          const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
          if (settled && Math.abs(mean - s.held) > this.p.driftDeg) s.moving = true;
        }
      }
      if (s.moving) {
        s.held += (x - s.held) * (1 - Math.exp(-dt / this.p.glideMs));
        if (Math.abs(x - s.held) < this.p.settleDeg) {
          s.moving = false;
          s.since = undefined;
        }
      }
      out ??= { ...pose };
      out[dof] = s.held;
    }
    return out ?? pose;
  }
}
