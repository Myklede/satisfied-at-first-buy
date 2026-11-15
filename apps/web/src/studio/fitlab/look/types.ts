// Fit Lab redesign contract (lead, 2026-11-15 03:05). Owners: R = see-through + scroll reveal,
// P = trousers, U = UI (theme, annotations, size picker), FL = integration + instant sizes.
// Change only through the lead (post a request in docs/requests/codex-sync.md).
import type { Object3D, PerspectiveCamera, SkinnedMesh, Vector3 } from 'three';
import type { SizeLabel } from '../../contract';

/** Fit zones painted on the shell. FL writes a per-vertex float attribute `fitZone` on every
 *  shell geometry (value = ZONE_INDEX[zone], -1 = no zone) so R's material can tint by zone. */
export type ZoneId = 'collar' | 'shoulder' | 'chest' | 'hem' | 'bicep' | 'cuff';
export const ZONE_INDEX: Record<ZoneId, number> = {
  collar: 0,
  shoulder: 1,
  chest: 2,
  hem: 3,
  bicep: 4,
  cuff: 5,
};
export const FIT_ZONE_ATTRIBUTE = 'fitZone';

/** What the see-through controller styles. */
export interface SeeThroughParts {
  /** Every mesh of the jacket currently shown (all S/M/L variants may be passed; hidden ones are ignored). */
  shells: Object3D[];
  /** The body mesh(es). */
  body: Object3D[];
  /** P's trousers, if present. */
  trousers?: Object3D[];
}

/** Only TIGHT (and snug) zones are tinted; good/loose read from the visible gap, never coloured. */
export interface TightZone {
  zone: ZoneId;
  /** 0..1: 0 = just snug, 1 = clearly tight (FL maps the engine's ease in cm to this). */
  severity: number;
}

/** R: the unified look / see-through rendering. reveal 0 = the product look (opaque jacket, as
 *  bought); reveal 1 = full see-through (crisp glass-like shell, body clearly inside). */
export interface SeeThrough {
  setParts(parts: SeeThroughParts): void;
  setReveal(t: number): void;
  setTightZones(zones: readonly TightZone[]): void;
  dispose(): void;
}

/** R: mouse wheel / pinch-zoom on the panel drives the camera from full-body framing (reveal 0)
 *  to a closer framing (reveal 1). Calls onReveal every change. */
export interface ScrollReveal {
  /** Current reveal 0..1. */
  value(): number;
  set(t: number, animate?: boolean): void;
  dispose(): void;
}
export interface ScrollRevealOptions {
  element: HTMLElement;
  camera: PerspectiveCamera;
  /** World-space framing targets, recomputed by FL when the body changes. */
  framing: () => { fullBodyCenter: Vector3; fullBodyDistance: number; closeCenter: Vector3; closeDistance: number };
  onReveal: (t: number) => void;
}

/** P: trousers that follow the posed body (same skeleton). */
export interface TrousersFactory {
  create(body: SkinnedMesh, opts: { hipY: number; ankleY: number; colour?: number }): SkinnedMesh;
}

/** U: on-image annotations with leader lines (replaces the notes list and the old callouts). */
export interface Annotation {
  id: string;
  /** World-space point on the jacket the line points to. */
  anchor: Vector3;
  title: string;
  detail: string;
  tone: 'tight' | 'snug' | 'good' | 'loose' | 'info';
}
export interface AnnotationLayer {
  mount(host: HTMLElement): void;
  /** visible: 0..1 fade (FL passes a function of reveal). */
  update(camera: PerspectiveCamera, viewport: { width: number; height: number }, items: readonly Annotation[], visible: number): void;
  dispose(): void;
}

/** U: size picker inside the Fit Lab, plus the one-line verdict for the SELECTED size only. */
export interface SizePicker {
  mount(host: HTMLElement, opts: { sizes: readonly SizeLabel[]; selected: SizeLabel; onSelect: (s: SizeLabel) => void }): void;
  setSelected(s: SizeLabel): void;
  /** e.g. { word: 'Good', tone: 'good', line: 'Fits your chest and shoulders; collar snug when zipped' } */
  setVerdict(v: { word: string; tone: 'tight' | 'snug' | 'good' | 'loose'; line: string } | null): void;
  dispose(): void;
}
