// Sleeve layers for the AR glue (agent V2). A hanging real arm is a ~30° rotation of the whole
// sleeve relative to the torso: one warped image cannot do that (the cells between sleeve and
// torso fold and the scale cap binds; user's live recording 15:18: sleeves stuck out in an
// A-pose). So the kiosk jacket is split by its cloth panels into a torso layer (with the hood and
// hardware) and one layer per sleeve, rendered separately (each complete: the torso behind a
// sleeve is rendered too), warped separately and composited torso first, sleeves on top.
//
// The split uses proxy meshes that SHARE the shell's geometry attributes and material (so the
// look, the live relief and the program are the kiosk's), with an index subset per layer. The
// sleeve panels are the panels of the asset's cuff landmarks (cuff_L / cuff_R).
import { BufferAttribute, BufferGeometry, Mesh, type Object3D } from 'three';
import type { ClothAsset } from '../../../api';

export type LayerName = 'torso' | 'sleeveL' | 'sleeveR';

/**
 * The sleeve-cap vertices (armhole down to and including the bicep ring) of one sleeve, from the
 * asset's `sleeve_*` path (the first vertex of every sleeve-grid row, armhole loop first) and
 * `bicep_*` ring; empty when the asset lacks them. Rows are contiguous id blocks (shell.py).
 */
export function sleeveCapRows(
  paths: Partial<Record<string, readonly number[]>>,
  side: 'L' | 'R',
): { firstRowStart: number; capEnd: number } | null {
  const line = paths[`sleeve_${side}`],
    bicep = paths[`bicep_${side}`];
  if (!line || line.length < 3 || !bicep?.length) return null;
  const row = line.indexOf(bicep[0]);
  if (row < 1 || row + 1 >= line.length) return null;
  // Ids of rows 1..row lie in [line[1], line[row + 1]).
  return { firstRowStart: line[1], capEnd: line[row + 1] };
}

export class SleeveLayers {
  private shell?: Mesh;
  private indexKey?: unknown;
  readonly proxies = new Map<LayerName, Mesh>();
  /**
   * F3 (?f3arms=1, D8): the sleeve caps (armhole → bicep) are drawn in the torso layer too, so a
   * small offset between the separately warped sleeve and torso cannot open a gap at the
   * shoulder (the dark notch: the person's clothes, then the coverage fill, showing through).
   */
  capInTorso = false;
  /**
   * F3 (?f3shoulder=1): the dropped shoulder's cap (asset path `dropped_cap_*`: sleeve-grid
   * vertices on the body side of the dropped seam, which carry the BODY panel) is drawn with its
   * SLEEVE, not with the torso. In the torso layer it stood out as a square shoulder pad with a
   * step where the separately warped sleeve began (F4T's real | AR sheets, both jackets); with the
   * sleeve, the shoulder line falls with the arm like the real dropped shoulder.
   */
  dropCapToSleeve = false;

  /** The kiosk shell mesh inside the GarmentLayer (the mesh drawing the asset's particles). */
  private findShell(layer: Object3D, asset: ClothAsset): Mesh | undefined {
    let found: Mesh | undefined;
    layer.traverse((o) => {
      if (found || !(o instanceof Mesh) || [...this.proxies.values()].includes(o)) return;
      const position = (o.geometry as BufferGeometry).getAttribute('position');
      if (position && position.count === asset.panels.length) found = o;
    });
    return found;
  }

  /**
   * Builds or refreshes the proxies for this frame. Returns false when the layers cannot be
   * built (no shell yet, no cuff landmarks): the caller draws the jacket as one layer.
   */
  update(layer: Object3D, asset: ClothAsset): boolean {
    const shell = this.findShell(layer, asset);
    const cuffL = asset.landmarks.cuff_L,
      cuffR = asset.landmarks.cuff_R;
    if (!shell || cuffL === undefined || cuffR === undefined) return false;
    const geometry = shell.geometry as BufferGeometry;
    const index = geometry.getIndex();
    if (!index) return false;
    // The GarmentLayer swaps the index (hood shown/hidden): rebuild the subsets when it changes.
    const key = `${index.id}:${index.count}:${index.version}:${this.capInTorso}:${this.dropCapToSleeve}`;
    if (shell === this.shell && key === this.indexKey) return true;
    this.dispose();
    this.shell = shell;
    this.indexKey = key;
    const pL = asset.panels[cuffL],
      pR = asset.panels[cuffR];
    const parts: Record<LayerName, number[]> = { torso: [], sleeveL: [], sleeveR: [] };
    const ix = index.array;
    const caps = this.capInTorso
      ? [sleeveCapRows(asset.paths, 'L'), sleeveCapRows(asset.paths, 'R')]
      : [null, null];
    const inCap = (v: number) => caps.some((c) => !!c && v >= c.firstRowStart && v < c.capEnd);
    const dropL = new Set(this.dropCapToSleeve ? (asset.paths.dropped_cap_L ?? []) : []),
      dropR = new Set(this.dropCapToSleeve ? (asset.paths.dropped_cap_R ?? []) : []);
    const isL = (v: number) => asset.panels[v] === pL || dropL.has(v),
      isR = (v: number) => asset.panels[v] === pR || dropR.has(v);
    for (let t = 0; t < index.count; t += 3) {
      const a = ix[t],
        b = ix[t + 1],
        c = ix[t + 2];
      const pa = asset.panels[a];
      const all = (p: number) => pa === p && asset.panels[b] === p && asset.panels[c] === p;
      const into = all(pL)
        ? parts.sleeveL
        : all(pR)
          ? parts.sleeveR
          : this.dropCapToSleeve && isL(a) && isL(b) && isL(c)
            ? parts.sleeveL
            : this.dropCapToSleeve && isR(a) && isR(b) && isR(c)
              ? parts.sleeveR
              : parts.torso;
      into.push(a, b, c);
      // The cap also in the torso layer (its sleeve layer still draws it on top).
      if (into !== parts.torso && inCap(a) && inCap(b) && inCap(c)) parts.torso.push(a, b, c);
    }
    for (const [name, ids] of Object.entries(parts) as [LayerName, number[]][]) {
      const g = new BufferGeometry();
      for (const [attr, value] of Object.entries(geometry.attributes)) g.setAttribute(attr, value);
      g.setIndex(new BufferAttribute(Uint32Array.from(ids), 1));
      const m = new Mesh(g, shell.material);
      m.customDepthMaterial = shell.customDepthMaterial;
      m.onBeforeRender = shell.onBeforeRender;
      m.castShadow = shell.castShadow;
      m.receiveShadow = shell.receiveShadow;
      m.renderOrder = shell.renderOrder;
      m.frustumCulled = false;
      m.visible = false;
      shell.parent?.add(m);
      this.proxies.set(name, m);
    }
    return true;
  }

  /**
   * Shows exactly one layer of the jacket (the shell itself hidden): `torso` also shows the hood
   * and hardware; a sleeve shows only its sleeve. Returns a restore function.
   */
  show(name: LayerName | 'all', layer: Object3D): () => void {
    const shell = this.shell;
    const saved: [Object3D, boolean][] = [];
    const set = (o: Object3D, v: boolean) => {
      saved.push([o, o.visible]);
      o.visible = v;
    };
    if (shell) {
      for (const child of shell.parent?.children ?? []) {
        if (child === shell) set(child, name === 'all');
        else if ([...this.proxies.values()].includes(child as Mesh))
          set(child, name !== 'all' && this.proxies.get(name) === child);
        // hood, hardware and anything else attached to the jacket: with the torso layer.
        else set(child, name === 'all' || name === 'torso');
      }
    }
    void layer;
    return () => {
      for (let i = saved.length - 1; i >= 0; i--) saved[i][0].visible = saved[i][1];
    };
  }

  dispose() {
    for (const m of this.proxies.values()) {
      m.parent?.remove(m);
      // Attributes are the shell's: dispose only the subset index (geometry object).
      m.geometry.dispose();
    }
    this.proxies.clear();
    this.shell = undefined;
    this.indexKey = undefined;
  }
}
