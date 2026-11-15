// "Select size M on this page": set Amazon's own size selector, the way a click would.
import { canonicalSize } from './sizes';

export interface SelectResult {
  ok: boolean;
  how: 'dropdown' | 'swatch' | 'none';
  detail: string;
}

const SWATCH_SCOPES =
  '#variation_size_name, [id^="inline-twister-row-size_name"], #tp-inline-twister-dim-values-container';

function labelOf(el: Element): string {
  const title = el.getAttribute('title') ?? '';
  // Amazon swatch titles read "Click to select M".
  const fromTitle = /select\s+(.+)$/i.exec(title)?.[1];
  return (fromTitle ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function selectSize(doc: Document, size: string): SelectResult {
  const wanted = canonicalSize(size) ?? size;
  for (const select of Array.from(
    doc.querySelectorAll<HTMLSelectElement>('select[id*="size_name"], select[name*="size_name"]'),
  )) {
    const option = Array.from(select.options).find(
      (o) => o.value !== '-1' && canonicalSize(o.textContent ?? '') === wanted,
    );
    if (option) {
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, how: 'dropdown', detail: `chose "${option.textContent?.trim()}"` };
    }
  }
  for (const scope of Array.from(doc.querySelectorAll(SWATCH_SCOPES))) {
    const item = Array.from(scope.querySelectorAll('li, [role="radio"], button')).find(
      (el) => canonicalSize(labelOf(el)) === wanted,
    );
    if (item) {
      const target =
        item.querySelector<HTMLElement>('input.a-button-input, button, .a-button-text') ??
        (item as HTMLElement);
      target.click();
      return { ok: true, how: 'swatch', detail: `clicked "${labelOf(item)}"` };
    }
  }
  return { ok: false, how: 'none', detail: `size ${size} is not offered by this page's selector` };
}
