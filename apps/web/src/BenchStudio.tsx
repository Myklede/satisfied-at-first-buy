import { useEffect, useRef, useState } from 'react';
import { api, type FitRequest, type GarmentFitResponse } from './api';
import { Viewer } from './engine/Viewer';
import type { GarmentMode } from './engine/garmentMath';
import type { Preset } from './engine/CameraRig';
import { settledMetrics, stretchResidual } from './engine/cloth/metrics';

type View = Preset | 'cuff' | 'hood' | 'quilting';
type LoadResult = {
  style: string;
  size: string;
  particles: number;
  settleMs: number;
  solverMs: number | null;
  sizeSwitchMs: number;
  cached: boolean;
  assetBytes: number;
  maxStrain: number;
  violatingEdges: number;
  energy: number;
  stopReason: string;
};
type Bench = {
  ready: boolean;
  error: string | null;
  renderer: string;
  latest?: LoadResult;
  load: (request: FitRequest, style: string, size: string) => Promise<LoadResult>;
  size: (size: string) => Promise<LoadResult>;
  view: (view: View) => Promise<void>;
  /** Look-dev: place the camera exactly (metres, scene frame) for matched-angle renders. */
  camera: (position: number[], target: number[], fov?: number) => Promise<void>;
  mode: (mode: GarmentMode) => void;
  fps: (quality: 'High' | 'Medium') => ReturnType<Viewer['sampleFps']>;
  interactive: (quality: 'High' | 'Medium') => Promise<unknown>;
  quality: (quality: 'High' | 'Medium') => void;
  dump: () => unknown;
  wrap: () => Promise<void>;
};
declare global {
  interface Window {
    __satisfyBench?: Bench;
  }
}
const frames = async (count: number) => {
  for (let i = 0; i < count; i++)
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
};

export function BenchStudio() {
  const canvas = useRef<HTMLDivElement>(null),
    [status, setStatus] = useState('Preparing local benchmark…');
  useEffect(() => {
    const viewer = new Viewer(canvas.current!, () => undefined);
    viewer.idleTurntable = false;
    viewer.tapes.visible = false;
    viewer.fitAnnotations.visible = false;
    let fit: GarmentFitResponse | undefined,
      style = '';
    let preview: ReturnType<typeof settledMetrics> | undefined;
    let previewPositions: Float32Array | undefined;
    async function selectSize(size: string) {
      if (!fit) throw new Error('Load a body and product first');
      preview = undefined;
      previewPositions = undefined;
      setStatus(`Computing ${style} · ${size}…`);
      const started = performance.now();
      await viewer.setGarment(fit, size);
      const { asset, state } = viewer.lastSimulation!;
      const result = {
        style,
        size,
        particles: asset.rest.length / 3,
        settleMs: state.elapsedMs,
        solverMs: state.meanStepMs,
        sizeSwitchMs: performance.now() - started,
        cached: state.cached,
        assetBytes: new TextEncoder().encode(JSON.stringify(asset)).length,
        ...stretchResidual(asset, state.positions),
        energy: state.energy,
        stopReason: state.stopReason,
      };
      bench.latest = result;
      setStatus(
        `${style} · ${size} · ${result.particles.toLocaleString()} particles · ${result.settleMs.toFixed(0)} ms ${state.cached ? 'cached state' : 'computed settle'}`,
      );
      await frames(3);
      return result;
    }
    const bench: Bench = {
      ready: true,
      error: null,
      renderer: (() => {
        const gl = viewer.renderer.getContext();
        const info = gl.getExtension('WEBGL_debug_renderer_info');
        return String(gl.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
      })(),
      load: async (request, nextStyle, size) => {
        try {
          const body = await api.fit(request),
            landmarks = await api.landmarks(body.body_id);
          await viewer.setBody(body, landmarks);
          const product = (await api.products()).find((p) => p.style === nextStyle);
          if (!product) throw new Error('Unknown local product');
          style = nextStyle;
          fit = await api.garmentFit({
            body_id: body.body_id,
            product_id: product.product_id,
            layer_cm: 0.3,
            preference: 'regular',
          });
          return await selectSize(size);
        } catch (error) {
          bench.error = String(error);
          setStatus(String(error));
          throw error;
        }
      },
      size: selectSize,
      wrap: async () => {
        const sim = viewer.lastSimulation;
        if (!sim) throw new Error('Load a garment before inspecting its initial wrap');
        const state = await viewer.garment.preview(sim.asset);
        previewPositions = state.positions;
        preview = settledMetrics(sim.asset, state.positions, sim.analytic);
        setStatus(`${style} / WRAPPED PREVIEW / UNSIMULATED / acceptance pending`);
        await frames(3);
      },
      mode: (mode) => viewer.setMode(mode, fit),
      fps: (quality) => viewer.sampleFps(quality),
      quality: (quality) => viewer.setQuality(quality),
      interactive: async (quality) => {
        viewer.setQuality(quality);
        const [render, physics] = await Promise.all([
          viewer.sampleFps(quality),
          viewer.garment.cloth.measureFrames(),
        ]);
        return { quality, render, physics };
      },
      view: async (view) => {
        viewer.idleTurntable = false;
        if (['front', 'back', 'shoulder', 'side', 'shoulders'].includes(view))
          viewer.rig.preset(view as Preset);
        else {
          const sim = viewer.lastSimulation;
          if (!sim) throw new Error('No simulated garment');
          const a = (preview ?? sim.simulated).anchors;
          let target = a.cuff_L,
            offset = [0.15, 0.05, 0.6];
          if (view === 'hood') {
            const p = previewPositions ?? sim.state.positions,
              ids = sim.asset.panels.flatMap((panel, i) => (panel === 7 ? [i] : []));
            target = [0, 0, 0];
            for (const i of ids) for (let k = 0; k < 3; k++) target[k] += p[i * 3 + k] / ids.length;
            offset = [0.25, 0.12, -0.65];
          } else if (view === 'quilting') {
            target = [0, (a.hem_back[1] + sim.asset.body_landmarks.C7[1]) * 0.5, a.hem_back[2]];
            offset = [0.1, 0, -0.65];
          }
          // Stop a pending preset transition through the same controls event.
          viewer.controls.dispatchEvent({ type: 'start' });
          viewer.controls.target.set(...target);
          viewer.camera.position.set(
            target[0] + offset[0],
            target[1] + offset[1],
            target[2] + offset[2],
          );
          viewer.controls.update();
        }
        await frames(90);
      },
      camera: async (position, target, fov = 35) => {
        viewer.idleTurntable = false;
        viewer.controls.dispatchEvent({ type: 'start' });
        viewer.camera.fov = fov;
        viewer.camera.updateProjectionMatrix();
        viewer.controls.target.set(target[0], target[1], target[2]);
        viewer.camera.position.set(position[0], position[1], position[2]);
        viewer.controls.update();
        await frames(60);
      },
      dump: () => {
        const sim = viewer.lastSimulation;
        if (!sim) return null;
        return {
          phase: preview ? 'wrapped_unsimulated' : 'relaxed',
          asset: sim.asset,
          positions: Array.from(previewPositions ?? sim.state.positions),
          analytic: sim.analytic,
          simulated: preview ? null : sim.simulated,
        };
      },
    };
    window.__satisfyBench = bench;
    return () => {
      delete window.__satisfyBench;
      viewer.dispose();
    };
  }, []);
  return (
    <main className="benchmark-stage">
      <header>
        <b>SATISFY / LOCAL REALISM VALIDATION</b>
        <span>{status}</span>
      </header>
      <div ref={canvas} className="benchmark-canvas" />
      <footer>
        Tape-true wrapped garment (03c fallback, no cloth simulation) · Rest tapes preserved ·
        Hood/cuff/material assumptions uncalibrated · No logos · Gates: realism-quality.json
      </footer>
    </main>
  );
}
