// Offline detector diagnosis on locally captured, continuous source frames. No target assertions
// or private frame data are committed. Run CXTRY_REPLAY=1 with this single Vitest file/one worker.
import { expect, it } from 'vitest';
import type { LiveFrame } from '../contract';
import { StillnessLock, type StillnessParams } from '../ar/stillness';
import { STILLNESS } from '../ar/config';

const env =
  (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const root = new URL('../../../../../../', import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  '$1',
);

it.runIf(env.CXTRY_REPLAY === '1')(
  'reports detector engagement on measured private frames',
  async () => {
    const fsName = 'node:fs';
    const fs = (await import(/* @vite-ignore */ fsName)) as {
      readdirSync(path: string): string[];
      readFileSync(path: string, encoding: string): string;
      writeFileSync(path: string, text: string): void;
    };
    const cpName = 'node:child_process';
    const cp = (await import(/* @vite-ignore */ cpName)) as {
      execFileSync(file: string, args: string[], options: { cwd: string }): unknown;
    };
    const folder = `${root}.cache/cx-try/mirror/`;
    const latest = fs
      .readdirSync(folder)
      .filter((p) => /^current-still-browser-\d+T\d+Z\.json$/.test(p))
      .sort()
      .at(-1);
    if (!latest) throw Error('Run TRY-M continuous raw capture first');
    const trace = JSON.parse(fs.readFileSync(folder + latest, 'utf8')) as {
      results: {
        video: string;
        window: number[];
        still: string;
        rawFrames: (LiveFrame & { videoTime: number })[];
      }[];
    };
    const output = [];
    for (const row of trace.results.filter((r) => r.rawFrames?.length && r.window[1] <= 6)) {
      for (const cutoff of [0.1, 0.4, 1])
        for (const beta of [0, 0.005, 0.05]) {
          for (const watched of ['all', 'torso'] as const) {
            const params: StillnessParams = {
              ...STILLNESS,
              landmarks: watched === 'torso' ? [11, 12, 23, 24] : STILLNESS.landmarks,
              smooth: { minCutoff: cutoff, beta, dCutoff: 1 },
            };
            const detector = new StillnessLock(params);
            const samples = row.rawFrames
              .map((frame) => {
                const l = frame.landmarks2d;
                const span =
                  l?.[11] && l[12] ? Math.hypot(l[11].x - l[12].x, l[11].y - l[12].y) : 0;
                const state = detector.update(frame.t, frame.pose ? l : null, span);
                return { time: frame.videoTime, held: state.engaged, speed: state.speed };
              })
              .filter((s) => s.time >= row.window[0] && s.time <= row.window[1]);
            output.push({
              clip: row.video,
              sourceStill: row.still,
              cutoff,
              beta,
              watched,
              frames: samples.length,
              heldShare: samples.length
                ? samples.filter((s) => s.held).length / samples.length
                : null,
              speedMin: samples.length ? Math.min(...samples.map((s) => s.speed)) : null,
              speedMax: samples.length ? Math.max(...samples.map((s) => s.speed)) : null,
            });
          }
        }
    }
    const path = `${root}.cache/cx-try/detector-replay.json`;
    cp.execFileSync('git', ['check-ignore', '-q', path], { cwd: root });
    fs.writeFileSync(path, JSON.stringify({ input: latest, results: output }, null, 2));
    expect(output.length).toBeGreaterThan(0);
    console.log(`Measured ${output.length} detector/clip configurations; private summary ${path}`);
  },
);
