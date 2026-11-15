// The person the Fit Lab builds, entered on this machine ("Your body"). Stored ONLY in this
// browser's localStorage (never committed, never sent anywhere but the local body service through
// the kiosk's own fitBody path). Ranges and parsing are the kiosk's (kiosk/units.ts parseYou).
import { parseYou } from '../../kiosk/units';

export interface EnteredPerson {
  height_cm: number;
  weight_kg: number;
  sex: 'female' | 'male';
}

export const PERSON_STORAGE_KEY = 'satisfy.fitlab.person.v1';

/** Validates form text with the kiosk's parser (metric). */
export function parsePerson(
  heightCm: string,
  weightKg: string,
  sex: string,
): { ok: true; person: EnteredPerson } | { ok: false; error: string } {
  if (sex !== 'female' && sex !== 'male') return { ok: false, error: 'Please pick a body shape.' };
  const r = parseYou({
    units: 'metric',
    heightCm,
    weightKg,
    heightFt: '',
    heightIn: '',
    weightLb: '',
  });
  if (!r.ok) return { ok: false, error: [r.height, r.weight].filter(Boolean).join(' ') };
  return { ok: true, person: { height_cm: r.height_cm, weight_kg: r.weight_kg, sex } };
}

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>;
const store = (): Storage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/** The stored person, re-validated (a tampered or stale value is ignored, never trusted). */
export function loadPerson(storage: Storage | null = store()): EnteredPerson | null {
  try {
    const raw = storage?.getItem(PERSON_STORAGE_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<EnteredPerson>;
    const r = parsePerson(
      String(v.height_cm ?? ''),
      String(v.weight_kg ?? ''),
      String(v.sex ?? ''),
    );
    return r.ok ? r.person : null;
  } catch {
    return null;
  }
}

/** Saves (or with null forgets) the person on this machine only. */
export function savePerson(person: EnteredPerson | null, storage: Storage | null = store()) {
  try {
    if (person) storage?.setItem(PERSON_STORAGE_KEY, JSON.stringify(person));
    else storage?.removeItem(PERSON_STORAGE_KEY);
  } catch {
    // Private mode / quota: the values simply are not remembered.
  }
}
