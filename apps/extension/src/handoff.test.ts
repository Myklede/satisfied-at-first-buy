import { expect, it } from 'vitest';
import { handoffUrl } from './handoff';
it('puts body data and fit choices only into a fragment on a validated local catalogue route', () => {
  const origin = 'http://127.0.0.1:5710',
    choices = { layer: 'hoodie', preference: 'relaxed' } as const,
    url = handoffUrl(
      origin + '/?product=' + 'a'.repeat(64) + '&size=M',
      origin,
      { sex: 'male', height_cm: 175, weight_kg: 62 },
      choices,
    );
  expect(new URL(url).search).not.toContain('175');
  expect(new URL(url).search).not.toContain('hoodie');
  const fragment = new URL(url).hash.slice('#handoff='.length);
  expect(JSON.parse(atob(fragment.replace(/-/g, '+').replace(/_/g, '/')))).toEqual({
    sex: 'male',
    height_cm: 175,
    weight_kg: 62,
    layer: 'hoodie',
    preference: 'relaxed',
  });
  expect(() =>
    handoffUrl(
      'https://example.com',
      origin,
      { sex: 'male', height_cm: 175, weight_kg: 62 },
      choices,
    ),
  ).toThrow();
});
