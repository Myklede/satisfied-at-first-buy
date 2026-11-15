import { expect, it, vi } from 'vitest';
import { consumeHandoff, knownChoices } from './handoff';
it('reads and clears valid input once, rejects invalid fields/ranges, and ignores kiosk data', () => {
  const history = { replaceState: vi.fn() },
    search = '?product=' + 'a'.repeat(64) + '&size=M';
  const encode = (data: unknown) =>
    '#handoff=' +
    btoa(JSON.stringify(data)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const body = { sex: 'male', height_cm: 175, weight_kg: 62, chest_cm: 85 };
  const choices = { layer: 'hoodie', preference: 'relaxed' };
  const value = consumeHandoff(
    { pathname: '/', search, hash: encode({ ...body, ...choices }) },
    history,
  ).value;
  expect(value?.body).toEqual(body);
  expect(value).toMatchObject(choices);
  expect(history.replaceState).toHaveBeenLastCalledWith(null, '', '/' + search);
  for (const data of [
    { ...body, ...choices, sex: 'other' },
    { ...body, ...choices, height_cm: 221 },
    { ...body, ...choices, weight_kg: 29 },
    { ...body, ...choices, chest_cm: 44 },
    { ...body, ...choices, extra: true },
    body, // choices are required: never guessed
    { ...body, ...choices, layer: 'Hoodie<script>' },
    { ...body, ...choices, preference: 3 },
  ])
    expect(consumeHandoff({ pathname: '/', search, hash: encode(data) }, history).error).toContain(
      'invalid',
    );
  expect(
    consumeHandoff(
      { pathname: '/', search: search + '&kiosk', hash: encode({ ...body, ...choices }) },
      history,
    ),
  ).toEqual({ ignored: true });
  expect(consumeHandoff({ pathname: '/', search, hash: '' }, history)).toEqual({});
});

it('captures the fragment before replaceState mutates the live Location', () => {
  const body = { sex: 'male', height_cm: 175, weight_kg: 62 };
  const fragment = { ...body, layer: 't-shirt', preference: 'regular' };
  const location = {
    pathname: '/',
    search: '?product=' + 'a'.repeat(64) + '&size=S',
    hash: '#handoff=' + btoa(JSON.stringify(fragment)).replace(/=+$/, ''),
  };
  const history = {
    replaceState: () => {
      location.hash = '';
    },
  };
  expect(consumeHandoff(location, history).value?.body).toEqual(body);
  expect(location.hash).toBe('');
  expect(consumeHandoff(location, history)).toEqual({});
});

it('accepts only layer and preference values that are studio presets', () => {
  const options = {
    layer_presets_cm: { 't-shirt': 0.3, hoodie: 0.9 },
    preferences: ['fitted', 'regular', 'relaxed'],
  };
  expect(knownChoices({ layer: 'hoodie', preference: 'relaxed' }, options)).toEqual({
    under: 'hoodie',
    preference: 'relaxed',
  });
  expect(knownChoices({ layer: 'parka', preference: 'regular' }, options)).toBeNull();
  expect(knownChoices({ layer: 'hoodie', preference: 'baggy' }, options)).toBeNull();
  expect(knownChoices({ layer: 'constructor', preference: 'regular' }, options)).toBeNull();
  expect(
    knownChoices({ layer: 'hoodie', preference: 'fitted' }, { ...options, preferences: [] }),
  ).toBeNull();
});
