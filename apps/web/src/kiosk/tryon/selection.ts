import type { LiveTryOn } from '../../engine/live/contract';
/** A baked move belongs to its garment/size. Leave replay before loading another asset. */
export async function switchLiveSelection(
  engine: Pick<LiveTryOn, 'backToLive' | 'setProduct' | 'setSize'>,
  selection: { size: string; product?: { productId: string; fitId: string } },
): Promise<void> {
  engine.backToLive();
  if (selection.product)
    await engine.setProduct(selection.product.productId, selection.product.fitId);
  await engine.setSize(selection.size);
}
