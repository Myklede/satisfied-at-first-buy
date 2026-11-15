import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api';
import { clothAsset } from './MotionClient';

afterEach(() => vi.restoreAllMocks());

const FIT = 'a'.repeat(64);
const gone = () => new Error('Body service unavailable (410). Check that npm run dev is running.');

describe('motion cloth assets', () => {
  it('asks once more after a 410 (a build cancelled by a reset elsewhere)', async () => {
    const asset = { size: 'M' } as unknown as Awaited<ReturnType<typeof api.cloth>>;
    const cloth = vi.spyOn(api, 'cloth').mockRejectedValueOnce(gone()).mockResolvedValueOnce(asset);
    await expect(clothAsset(FIT, 'M', new AbortController().signal)).resolves.toBe(asset);
    expect(cloth).toHaveBeenCalledTimes(2);
  });

  it('does not retry after its own reset (aborted) or on other errors', async () => {
    const aborted = new AbortController();
    aborted.abort();
    const cloth = vi.spyOn(api, 'cloth').mockRejectedValue(gone());
    await expect(clothAsset(FIT, 'M', aborted.signal)).rejects.toThrow('(410)');
    expect(cloth).toHaveBeenCalledTimes(1);
    cloth.mockReset().mockRejectedValue(new Error('Body expired from memory.'));
    await expect(clothAsset(FIT, 'M', new AbortController().signal)).rejects.toThrow('expired');
    expect(cloth).toHaveBeenCalledTimes(1);
  });

  it('retries a 410 only once', async () => {
    const cloth = vi.spyOn(api, 'cloth').mockRejectedValue(gone());
    await expect(clothAsset(FIT, 'M', new AbortController().signal)).rejects.toThrow('(410)');
    expect(cloth).toHaveBeenCalledTimes(2);
  });
});
