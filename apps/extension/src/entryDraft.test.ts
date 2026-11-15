import { expect, it } from 'vitest';
import { EntryDraft } from './entryDraft';
it('preserves exact typed strings through unit toggles and invalidates stale conversions after an edit', () => {
  const draft = new EntryDraft(),
    entry = { units: 'imperial', height: '70.00', weight: '160', chest: '', sex: 'male' } as const;
  const metric = draft.change(entry, 'metric');
  expect(metric.height).toBe('177.8');
  expect(metric.weight).toBe('72.6');
  expect(draft.change(metric, 'imperial')).toEqual(entry);
  draft.edit({ ...metric, height: '180' });
  expect(draft.change({ ...metric, height: '180' }, 'imperial').height).not.toBe('70.00');
  expect(draft.change({ ...metric, height: '180' }, 'imperial').weight).toBe('160');
});
