// Read PRODUCT content from the Amazon page the shopper is viewing (their own browser, no
// scraping). Mirrors body_service/agent/pagetext.py so saved pages and live pages agree.
import { canonicalSize } from './sizes';
import type { PageContent, PageTable } from './types';

const LIMITS = { tables: 12, rows: 60, cols: 20, cell: 120, text: 6000, bullets: 20 };
const MEASURE_WORDS = /chest|bust|shoulder|sleeve|length|waist|hip|bicep|pit to pit|width/i;

export function asinFromUrl(url: string): string | null {
  const match = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?#]|$)/.exec(url);
  return match ? match[1] : null;
}

export function cleanBrand(text: string): string {
  return text
    .replace(/^\s*(?:visit the|brand:)\s*/i, '')
    .replace(/\s+store\s*$/i, '')
    .trim();
}

const squash = (text: string | null | undefined) => (text ?? '').replace(/\s+/g, ' ').trim();

/** True when rows look like a size chart: size labels down a column (or across the top) and a
 * measurement word in the other header. Same idea as rules.py `_orient`. */
export function looksLikeSizeTable(rows: string[][]): boolean {
  if (rows.length < 2) return false;
  const sizesDown = rows.slice(1).filter((r) => r[0] && canonicalSize(r[0])).length;
  const sizesAcross = rows[0].slice(1).filter((c) => canonicalSize(c)).length;
  const firstSize = rows.findIndex((row) => row[0] && canonicalSize(row[0]));
  const headerWords = rows
    .slice(0, firstSize > 0 ? firstSize : 1)
    .some((row) => row.some((cell) => MEASURE_WORDS.test(cell)));
  const sideWords = rows.slice(1).some((r) => MEASURE_WORDS.test(r[0] ?? ''));
  return (sizesDown >= 2 && headerWords) || (sizesAcross >= 2 && sideWords);
}

export function tableRows(table: HTMLTableElement): string[][] {
  return expandTable(
    Array.from(table.rows)
      .slice(0, LIMITS.rows)
      .map((tr) =>
        Array.from(tr.cells)
          .slice(0, LIMITS.cols)
          .map((cell) => ({
            text: squash(cell.textContent).slice(0, LIMITS.cell),
            rows: cell.rowSpan,
            cols: cell.colSpan,
          })),
      ),
  );
}

export function expandTable(input: { text: string; rows: number; cols: number }[][]): string[][] {
  const grid: string[][] = [];
  input.slice(0, LIMITS.rows).forEach((row, r) => {
    grid[r] ??= [];
    let col = 0;
    for (const cell of row.slice(0, LIMITS.cols)) {
      while (grid[r][col] !== undefined && col < LIMITS.cols) col++;
      for (let y = 0; y < Math.min(Math.max(cell.rows || 1, 1), LIMITS.rows - r); y++) {
        grid[r + y] ??= [];
        for (let x = 0; x < Math.min(Math.max(cell.cols || 1, 1), LIMITS.cols - col); x++)
          grid[r + y][col + x] = cell.text;
      }
      col += Math.max(cell.cols || 1, 1);
    }
  });
  return grid.filter((row) => row.some(Boolean)).map((row) => Array.from(row, (v) => v ?? ''));
}

/** Caption, size/chart/unit markers on ancestors, and the text just before the table. */
export function headingOf(table: HTMLTableElement): string {
  const parts: string[] = [];
  if (table.caption) parts.push(squash(table.caption.textContent));
  let node: Element | null = table;
  for (let depth = 0; node && depth < 4; depth++) {
    const marker = [node.id, node.getAttribute('class'), node.getAttribute('aria-label')]
      .filter(Boolean)
      .join(' ');
    if (/size|chart|inch|\bcm\b|\bin\b/i.test(marker)) parts.push(marker);
    const before: string[] = [];
    let sibling = node.previousSibling;
    while (sibling && before.length < 3) {
      const text = squash(sibling.textContent);
      if (text) before.unshift(text);
      sibling = sibling.previousSibling;
    }
    if (before.length) {
      parts.push(before.join(' ').slice(-200));
      break;
    }
    node = node.parentElement;
  }
  return parts.join(' ').slice(0, 300);
}

export function readTables(root: ParentNode): PageTable[] {
  const tables: PageTable[] = [];
  for (const table of Array.from(root.querySelectorAll('table'))) {
    const rows = tableRows(table);
    if (rows.length >= 2) tables.push({ heading: headingOf(table), rows });
    if (tables.length >= LIMITS.tables) break;
  }
  return tables;
}

export function sizeOptions(doc: Document): string[] {
  const found: string[] = [];
  doc
    .querySelectorAll<HTMLOptionElement>(
      'select[id*="size_name"] option, select[name*="size_name"] option',
    )
    .forEach((option) => {
      if (option.value !== '-1') found.push(squash(option.textContent));
    });
  doc
    .querySelectorAll(
      '#variation_size_name li, [id^="inline-twister-row-size_name"] li, #tp-inline-twister-dim-values-container li',
    )
    .forEach((li) => found.push(squash(li.textContent)));
  return [...new Set(found.filter((s) => s && s.length <= LIMITS.cell))].slice(0, 40);
}

export function readPage(
  doc: Document,
  asin: string,
  origin: PageContent['chart_origin'],
): PageContent {
  const text = (selector: string) => squash(doc.querySelector(selector)?.textContent);
  return {
    asin,
    url: `https://www.amazon.com/dp/${asin}`,
    title: text('#productTitle').slice(0, 400),
    brand: cleanBrand(text('#bylineInfo')).slice(0, 200),
    bullets: Array.from(doc.querySelectorAll('#feature-bullets li'))
      .map((li) => squash(li.textContent).slice(0, 1000))
      .filter(Boolean)
      .slice(0, LIMITS.bullets),
    description: text('#productDescription').slice(0, LIMITS.text),
    size_options: sizeOptions(doc),
    tables: readTables(doc),
    chart_origin: origin,
  };
}

const TRIGGER = /size\s*chart|size\s*guide|sizing\s*info/i;

/** Amazon renders the size chart only after "Size chart" is clicked (a popover filled by an
 * AJAX call). If no size table is in the DOM yet, click the trigger and wait for one. */
export async function openSizeChart(doc: Document, timeoutMs = 5000): Promise<boolean> {
  const hasChart = () => readTables(doc).some((t) => looksLikeSizeTable(t.rows));
  if (hasChart()) return true;
  const trigger = Array.from(
    doc.querySelectorAll<HTMLElement>('a, button, [role="button"], span.a-declarative'),
  ).find((el) => TRIGGER.test(el.textContent ?? '') && (el.textContent ?? '').length < 60);
  if (!trigger) return false;
  trigger.click();
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    if (hasChart()) return true;
  }
  return false;
}

/** Close an Amazon popover we opened, so the page looks as the shopper left it. */
export function closePopover(doc: Document): void {
  const close = doc.querySelector<HTMLElement>(
    '.a-popover:not([aria-hidden="true"]) [data-action="a-popover-close"], .a-popover:not([aria-hidden="true"]) .a-button-close',
  );
  close?.click();
}

export function pageAsin(doc: Document, url: string): string | null {
  const fromUrl = asinFromUrl(url);
  if (fromUrl) return fromUrl;
  const input = doc.querySelector<HTMLInputElement>('input[name="ASIN"]');
  return input && /^[A-Z0-9]{10}$/.test(input.value) ? input.value : null;
}
