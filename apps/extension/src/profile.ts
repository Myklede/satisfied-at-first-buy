// Extension page (chrome-extension:// origin): the only place body data is entered or shown.
import type { BodyEntry, Choices, FitRequest, Learning, Message, Reply } from './types';
import { inToCm, lbToKg } from './units';
import { EntryDraft, type EntryValues } from './entryDraft';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

async function send<T>(message: Message): Promise<Reply<T>> {
  return chrome.runtime.sendMessage<Reply<T>>(message);
}

function say(text: string): void {
  $('status').textContent = text;
}

let previousUnits: EntryValues['units'] = 'imperial';
let draft = new EntryDraft();
function readEntry(): EntryValues {
  return {
    units: previousUnits,
    height: $<HTMLInputElement>('height').value,
    weight: $<HTMLInputElement>('weight').value,
    chest: $<HTMLInputElement>('chest').value,
    sex: $<HTMLSelectElement>('sex').value,
  };
}
function fill(entry: EntryValues): void {
  for (const id of ['height', 'weight', 'chest', 'sex'] as const)
    $<HTMLInputElement>(id).value = entry[id];
}
function units(): void {
  const next = $<HTMLSelectElement>('units').value as EntryValues['units'];
  if (next !== previousUnits) fill(draft.change(readEntry(), next));
  previousUnits = next;
  const imperial = next === 'imperial';
  document.querySelectorAll('.unit-len').forEach((el) => (el.textContent = imperial ? 'in' : 'cm'));
  document
    .querySelectorAll('.unit-mass')
    .forEach((el) => (el.textContent = imperial ? 'lb' : 'kg'));
  for (const mode of ['imperial', 'metric'])
    $('units-' + mode).setAttribute('aria-pressed', String(mode === next));
  summary();
}

export function assumptionSummary(request: FitRequest): string {
  return `${request.sex} body model · ${request.height_cm} cm · ${request.weight_kg} kg · ${request.known_measurements?.chest_cm ? `chest tape ${request.known_measurements.chest_cm} cm` : 'no chest tape; chest estimated by Anny'}. Other measurements are model estimates, not a body scan.`;
}

/** Readable leaf rows preserve every stored profile field, including defaults and consent metadata. */
export function storageRows(value: unknown, prefix = ''): [string, string][] {
  if (value !== null && typeof value === 'object')
    return Object.entries(value).flatMap(([name, child]) =>
      storageRows(child, `${prefix}${prefix ? ' / ' : ''}${name.replaceAll('_', ' ')}`),
    );
  return [[prefix, value == null ? 'Not provided' : String(value)]];
}

function summary(): void {
  try {
    const chest = $<HTMLInputElement>('chest').valueAsNumber;
    const request = toFitRequest(
      $<HTMLSelectElement>('units').value === 'imperial',
      $<HTMLInputElement>('height').valueAsNumber,
      $<HTMLInputElement>('weight').valueAsNumber,
      $<HTMLSelectElement>('sex').value,
      Number.isFinite(chest) ? chest : null,
    );
    $('assumptions').textContent = assumptionSummary(request);
  } catch {
    $('assumptions').textContent =
      'Enter body shape, height and weight within the supported adult ranges.';
  }
}

/** Form values → API units (cm, kg). Conversions: in × 2.54, lb × 0.45359237 (exact). */
export function toFitRequest(
  imperial: boolean,
  height: number,
  weight: number,
  sex: string,
  chest: number | null,
): FitRequest {
  const len = (v: number) => Math.round((imperial ? inToCm(v) : v) * 10) / 10;
  const request: FitRequest = {
    height_cm: len(height),
    weight_kg: Math.round((imperial ? lbToKg(weight) : weight) * 10) / 10,
    sex: sex === 'male' ? 'male' : 'female',
  };
  if (
    !['male', 'female'].includes(sex) ||
    !Number.isFinite(request.height_cm) ||
    request.height_cm < 120 ||
    request.height_cm > 220 ||
    !Number.isFinite(request.weight_kg) ||
    request.weight_kg < 30 ||
    request.weight_kg > 200
  )
    throw new Error('Unsupported body parameters');
  if (chest !== null && (!Number.isFinite(chest) || len(chest) < 45 || len(chest) > 200))
    throw new Error('Chest tape must be45–200 cm');
  if (chest) request.known_measurements = { chest_cm: len(chest) };
  return request;
}

async function refresh(): Promise<void> {
  const profile = await send<{
    saved: boolean;
    profile: { fit_request: FitRequest } | null;
    kiosk_mode: boolean;
    entry?: BodyEntry;
    choices?: Choices;
  }>({
    op: 'getProfile',
  });
  const saved = $('saved');
  saved.replaceChildren();
  if (!profile.ok) saved.textContent = profile.error.error;
  else {
    const entry = profile.data.entry;
    if (profile.data.choices) {
      $<HTMLSelectElement>('preference').value = profile.data.choices.preference;
      $<HTMLSelectElement>('layer').value = profile.data.choices.layer;
    }
    if (entry) {
      previousUnits = entry.units;
      $<HTMLSelectElement>('units').value = entry.units;
      draft.edit(entry);
      fill(entry);
      units();
    }
    const canonical = entry?.canonical ?? profile.data.profile?.fit_request;
    if (canonical) {
      const table = document.createElement('table');
      const rows: [string, string][] = [
        ['Storage', profile.data.saved ? 'Remembered with consent' : 'This browser session only'],
        ...storageRows(entry ?? {}, 'Original entry (private extension storage)'),
        ...storageRows(profile.data.profile ?? {}, 'Profile (local service)'),
      ];
      for (const [name, value] of rows) {
        const tr = document.createElement('tr'),
          th = document.createElement('th'),
          td = document.createElement('td');
        th.textContent = name;
        td.textContent = value;
        tr.append(th, td);
        table.append(tr);
      }
      saved.append(table);
    } else
      saved.textContent = profile.data.kiosk_mode
        ? 'Kiosk mode: nothing is stored.'
        : 'No saved profile.';
  }
  const learning = await send<Learning>({ op: 'learning' });
  const box = $('learning');
  box.replaceChildren();
  if (!learning.ok) return;
  for (const line of learning.data.learned) {
    const p = document.createElement('p');
    p.textContent = line;
    p.dataset.testid = 'learned';
    box.append(p);
  }
  for (const item of learning.data.items) {
    const row = document.createElement('p');
    row.className = 'muted';
    row.textContent = item.text + ' ';
    const undo = document.createElement('button');
    undo.textContent = 'Undo';
    undo.dataset.testid = 'undo';
    undo.addEventListener('click', async () => {
      await send({ op: 'undo', purchase_id: item.purchase_id });
      await refresh();
    });
    row.append(undo);
    box.append(row);
  }
  if (!learning.data.purchases.length) box.textContent = 'Nothing learned yet.';
}

function setup(): void {
  $('profile').addEventListener('input', (event) => {
    if (['height', 'weight', 'chest'].includes((event.target as HTMLElement).id))
      draft.edit(readEntry());
    summary();
  });
  for (const mode of ['imperial', 'metric'])
    $('units-' + mode).addEventListener('click', () => {
      $<HTMLSelectElement>('units').value = mode;
      units();
    });
  $('units').addEventListener('change', units);
  $('profile').addEventListener('submit', async (event) => {
    event.preventDefault();
    const sex = $<HTMLSelectElement>('sex').value;
    if (!sex) return say('Choose a body shape first.');
    const chest = $<HTMLInputElement>('chest').valueAsNumber;
    let request: FitRequest;
    try {
      request = toFitRequest(
        $<HTMLSelectElement>('units').value === 'imperial',
        $<HTMLInputElement>('height').valueAsNumber,
        $<HTMLInputElement>('weight').valueAsNumber,
        sex,
        Number.isFinite(chest) ? chest : null,
      );
    } catch {
      return say(
        'Check body shape and ranges: height120–220 cm, weight30–200 kg, optional chest45–200 cm.',
      );
    }
    const choices: Choices = {
      preference: $<HTMLSelectElement>('preference').value as Choices['preference'],
      layer: $<HTMLSelectElement>('layer').value as Choices['layer'],
    };
    const remember = $<HTMLInputElement>('remember').checked;
    const reply = await send({
      op: 'saveProfile',
      fit_request: request,
      choices,
      remember,
      entry: { ...readEntry(), canonical: request },
    });
    say(
      reply.ok
        ? remember
          ? 'Saved on this computer.'
          : 'Kept for this browser session only (not saved).'
        : reply.error.error,
    );
    await refresh();
  });
  $('delete').addEventListener('click', async () => {
    const reply = await send<{ deleted: string[] }>({ op: 'deleteProfile' });
    if (reply.ok) {
      $<HTMLFormElement>('profile').reset();
      draft = new EntryDraft();
      previousUnits = 'imperial';
      units();
    }
    say(
      reply.ok
        ? `Deleted: ${reply.data.deleted.join(', ') || 'nothing was stored'}. Session body cleared.`
        : reply.error.error,
    );
    await refresh();
  });
  units();
  void refresh();
}

if (typeof document !== 'undefined' && document.getElementById('profile')) setup();
