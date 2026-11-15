export interface EntryValues {
  units: 'imperial' | 'metric';
  height: string;
  weight: string;
  chest: string;
  sex: string;
}
/** Cache verbatim entries per unit system. Editing invalidates the converted counterpart. */
export class EntryDraft {
  private entries: Partial<Record<EntryValues['units'], Partial<EntryValues>>> = {};
  edit(entry: EntryValues): void {
    const previous = this.entries[entry.units];
    const other = this.entries[entry.units === 'metric' ? 'imperial' : 'metric'];
    if (other)
      for (const field of ['height', 'weight', 'chest'] as const) {
        if (previous?.[field] !== entry[field]) delete other[field];
      }
    this.entries[entry.units] = { ...entry };
  }
  change(entry: EntryValues, units: EntryValues['units']): EntryValues {
    this.entries[entry.units] = { ...entry };
    const old = this.entries[units] ?? {};
    const convert = (value: string, factor: number) =>
      value === ''
        ? ''
        : String(Number((Number(value) * (units === 'metric' ? factor : 1 / factor)).toFixed(1)));
    const next = {
      units,
      sex: entry.sex,
      height: old.height ?? convert(entry.height, 2.54),
      weight: old.weight ?? convert(entry.weight, 0.45359237),
      chest: old.chest ?? convert(entry.chest, 2.54),
    };
    this.entries[units] = next;
    return next;
  }
}
