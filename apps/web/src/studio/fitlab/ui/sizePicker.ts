// Size picker inside the Fit Lab (agent U): a segmented S | M | L control and ONE verdict line for
// the selected size only. Text comes from FL's verdict (engine numbers); nothing is invented here.
import type { SizeLabel } from '../../contract';
import type { SizePicker } from '../look/types';
import { TONE_COLOR } from './theme';
import '../fitlab.css';

type Verdict = { word: string; tone: 'tight' | 'snug' | 'good' | 'loose'; line: string };

export class SizePickerControl implements SizePicker {
  private root = document.createElement('div');
  private seg = document.createElement('div');
  private buttons = new Map<SizeLabel, HTMLButtonElement>();
  private word = document.createElement('span');
  private line = document.createElement('span');
  private verdict = document.createElement('div');

  constructor() {
    this.root.className = 'fl-sp';
    this.seg.className = 'fl-sp-seg';
    this.seg.setAttribute('role', 'radiogroup');
    this.seg.setAttribute('aria-label', 'Size');
    this.verdict.className = 'fl-sp-verdict';
    this.verdict.setAttribute('aria-live', 'polite');
    this.word.className = 'fl-sp-word';
    this.line.className = 'fl-sp-line';
    this.verdict.append(this.word, this.line);
    this.root.append(this.seg, this.verdict);
    this.setVerdict(null);
  }

  mount(
    host: HTMLElement,
    opts: { sizes: readonly SizeLabel[]; selected: SizeLabel; onSelect: (s: SizeLabel) => void },
  ) {
    this.seg.replaceChildren();
    this.buttons.clear();
    for (const s of opts.sizes) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = s;
      b.setAttribute('role', 'radio');
      b.addEventListener('click', () => {
        this.setSelected(s); // instant and local; FL swaps the preloaded size in onSelect
        opts.onSelect(s);
      });
      this.buttons.set(s, b);
      this.seg.append(b);
    }
    this.setSelected(opts.selected);
    host.append(this.root);
  }

  setSelected(s: SizeLabel) {
    for (const [k, b] of this.buttons) {
      b.classList.toggle('on', k === s);
      b.setAttribute('aria-checked', String(k === s));
    }
  }

  setVerdict(v: Verdict | null) {
    this.verdict.classList.toggle('empty', !v);
    if (!v) {
      this.word.textContent = '';
      this.line.textContent = '';
      return;
    }
    this.word.textContent = v.word;
    this.word.style.color = TONE_COLOR[v.tone];
    this.line.textContent = v.line;
  }

  dispose() {
    this.root.remove();
    this.buttons.clear();
  }
}

export function createSizePicker(): SizePicker {
  return new SizePickerControl();
}
