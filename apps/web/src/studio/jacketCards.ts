// Jacket picture cards (Studio picker). Before the shopper picks, a large "Choose a jacket" chooser
// sits over the big view; after a pick the same cards live as a compact rail in the bottom bar.
// Text comes from the product data (data/products/*.json: title, colourway, style; a unit test
// checks these strings against the files). Images are the closed Decart references from the
// gitignored public/local-textures/decart/ (slug + file logic of decartViewMap.ts); when the
// image is missing (public clone) the card stays a clean text-only card.
import type { JacketId } from './contract';
import { JACKET_SLUG } from './decartViewMap';

export interface JacketCardInfo {
  id: JacketId;
  /** Short label for the compact rail. */
  short: string;
  /** Product title, exactly as in data/products/*.json `title`. */
  title: string;
  /** data/products/*.json `colourway`. */
  colourway: string;
}

export const JACKET_CARDS: readonly JacketCardInfo[] = [
  {
    id: 'DQ4920-206',
    short: 'Puffer',
    title: "Nike Life Therma-FIT Men's Puffer",
    colourway: 'Rattan/Rattan',
  },
  {
    id: 'FB7675-100',
    short: 'Parka',
    title: "Nike Sportswear Classic Puffer — Women's Therma-FIT Parka",
    colourway: 'White/Black',
  },
];

/** Candidate URLs for a jacket's closed reference image, in the order decartViewMap prefers
 *  (hood on first, then no hood; png, jpg, jpeg, webp). */
export function cardImageCandidates(id: JacketId, base = '/local-textures/decart/'): string[] {
  const slug = JACKET_SLUG[id];
  const out: string[] = [];
  for (const hood of ['', '-nohood'])
    for (const ext of ['png', 'jpg', 'jpeg', 'webp']) out.push(`${base}${slug}-closed${hood}.${ext}`);
  return out;
}

/** The card's picture: the studio product photo first (gitignored public/local-textures/cards/
 *  <slug>.jpg, prepared locally from the brand's product images; never committed), then the
 *  Decart closed reference, then text only. */
export function cardPhotoCandidates(id: JacketId): string[] {
  return [`/local-textures/cards/${JACKET_SLUG[id]}.jpg`, ...cardImageCandidates(id)];
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  e.append(...children);
  return e;
}

/** Image element that walks the candidate list; on total failure it removes itself and marks the
 *  card text-only. */
function cardImage(id: JacketId, card: HTMLElement): HTMLImageElement {
  const urls = cardPhotoCandidates(id);
  const img = document.createElement('img');
  img.alt = '';
  img.decoding = 'async';
  let i = 0;
  img.onerror = () => {
    i += 1;
    if (i < urls.length) img.src = urls[i];
    else {
      img.remove();
      card.classList.add('no-img');
    }
  };
  img.src = urls[0];
  return img;
}

/** Bottom-bar Decart buttons: Start only after the shopper picked a jacket and while Decart is
 *  idle; Stop only while it is live or starting. Pure (unit-tested). */
export function decartControls(
  picked: boolean,
  active: boolean,
): { startDisabled: boolean; stopDisabled: boolean; startTitle: string } {
  return {
    startDisabled: active || !picked,
    stopDisabled: !active,
    startTitle: !picked ? 'Pick a jacket first' : active ? 'Decart is running' : 'Start Decart',
  };
}

export interface JacketCardSet {
  /** Root element of this set (chooser grid or rail). */
  root: HTMLElement;
  setSelected(id: JacketId | null): void;
}

/** Build one set of cards. `variant` 'large' for the chooser, 'thumb' for the bottom-bar rail. */
export function createJacketCards(
  variant: 'large' | 'thumb',
  onPick: (id: JacketId) => void,
): JacketCardSet {
  const buttons = JACKET_CARDS.map((j) => {
    const b = el('button', `jcard jcard-${variant}`);
    b.type = 'button';
    b.dataset.jacket = j.id;
    b.title = `${j.title} · ${j.colourway} · ${j.id}`;
    const pic = el('div', 'jcard-pic');
    pic.append(cardImage(j.id, b));
    const text =
      variant === 'large'
        ? el('div', 'jcard-text', [
            el('div', 'jcard-name', [j.title]),
            el('div', 'jcard-meta', [`${j.colourway} · Style ${j.id}`]),
          ])
        : el('div', 'jcard-text', [
            el('div', 'jcard-name', [j.short]),
            el('div', 'jcard-meta', [j.colourway]),
          ]);
    b.append(pic, text);
    b.addEventListener('click', () => onPick(j.id));
    return b;
  });
  const root = el('div', variant === 'large' ? 'jcards-large' : 'jcards-rail', buttons);
  return {
    root,
    setSelected(id) {
      for (const b of buttons) {
        const on = b.dataset.jacket === id;
        b.classList.toggle('on', on);
        b.setAttribute('aria-pressed', String(on));
      }
    },
  };
}
