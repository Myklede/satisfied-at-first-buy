import { expect, it } from 'vitest';
import { catalogueStudioUrl } from './bridge';
it('opens only measured catalogue routes, never invents chart-only geometry', () => {
  const origin = 'http://127.0.0.1:5710';
  expect(catalogueStudioUrl(undefined, origin)).toBeNull();
  expect(catalogueStudioUrl(`${origin}/?product=${'a'.repeat(64)}`, origin)).toContain('product=');
  for (const url of [
    'https://example.com/?product=' + 'a'.repeat(64),
    origin + '/?product=../bad',
    origin + '/other?product=' + 'a'.repeat(64),
  ])
    expect(catalogueStudioUrl(url, origin)).toBeNull();
});
