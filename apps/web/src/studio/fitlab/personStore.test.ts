import { describe, expect, it } from 'vitest';
import { loadPerson, parsePerson, PERSON_STORAGE_KEY, savePerson } from './personStore';

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

describe('Fit Lab person (local only, kiosk ranges)', () => {
  it('accepts the kiosk ranges and rejects outside them', () => {
    expect(parsePerson('180', '75', 'male')).toEqual({
      ok: true,
      person: { height_cm: 180, weight_kg: 75, sex: 'male' },
    });
    expect(parsePerson('119', '75', 'male').ok).toBe(false);
    expect(parsePerson('180', '201', 'female').ok).toBe(false);
    expect(parsePerson('180', '75', '').ok).toBe(false);
    expect(parsePerson('', '75', 'male').ok).toBe(false);
  });

  it('round-trips through storage and ignores tampered values', () => {
    const s = new MemoryStorage();
    expect(loadPerson(s)).toBeNull();
    savePerson({ height_cm: 165, weight_kg: 58, sex: 'female' }, s);
    expect(loadPerson(s)).toEqual({ height_cm: 165, weight_kg: 58, sex: 'female' });
    s.setItem(PERSON_STORAGE_KEY, JSON.stringify({ height_cm: 500, weight_kg: 58, sex: 'female' }));
    expect(loadPerson(s)).toBeNull();
    s.setItem(PERSON_STORAGE_KEY, '{not json');
    expect(loadPerson(s)).toBeNull();
    savePerson(null, s);
    expect(s.data.size).toBe(0);
  });
});
