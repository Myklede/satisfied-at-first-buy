import { CanvasTexture, RepeatWrapping } from 'three';
import { look } from './garmentLook';

/**
 * Height of the procedural weave at texel (x, y) of a `size` tile covering look.weaveTileM.
 * Ripstop: raised reinforcement threads on a ~5 mm grid (8 cells per 4 cm tile) over a plain
 * weave. Satin-matte: a fine twill. Pure function (unit tested); look convention, unmeasured.
 */
export function weaveHeight(glossy: boolean, x: number, y: number, size: number) {
  const cell = size / 8;
  if (glossy) {
    const cx = (((x % cell) + cell) % cell) - cell / 2,
      cy = (((y % cell) + cell) % cell) - cell / 2;
    const rib = (d: number) => Math.exp(-((Math.abs(d) - cell / 2) ** 2) / 1.6);
    const plain = 0.14 * Math.sin((x * Math.PI) / 2) * Math.sin((y * Math.PI) / 2);
    return Math.max(rib(cx), rib(cy)) + plain;
  }
  return 0.35 * Math.sin(((x + y) * Math.PI) / 3) + 0.1 * Math.sin((x * Math.PI) / 1.5);
}

/** Tangent-space normal map of the weave (tiles every look.weaveTileM in material metres). */
export function weaveNormalTexture(glossy: boolean) {
  const size = 256,
    canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const pixels = ctx.createImageData(size, size);
  const h = (x: number, y: number) =>
    weaveHeight(glossy, (x + size) % size, (y + size) % size, size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const k = (y * size + x) * 4;
      const nx = h(x - 1, y) - h(x + 1, y),
        ny = h(x, y - 1) - h(x, y + 1),
        l = Math.sqrt(nx * nx + ny * ny + 4);
      pixels.data[k] = Math.round((nx / l) * 127.5 + 127.5);
      pixels.data[k + 1] = Math.round((ny / l) * 127.5 + 127.5);
      pixels.data[k + 2] = Math.round((2 / l) * 127.5 + 127.5);
      pixels.data[k + 3] = 255;
    }
  ctx.putImageData(pixels, 0, 0);
  const texture = new CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.anisotropy = 8;
  texture.name = `weave-${glossy ? 'ripstop' : 'satin'}-${look.weaveTileM}m`;
  return texture;
}
