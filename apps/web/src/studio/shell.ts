// Studio shell: layout + bottom bar (prompts/31). Big slot left (~2/3): Decart when live, else the
// fallback (plain camera + overlay host). Right: the Fit Lab panel host. Bottom bar: jacket,
// zip slider (size lives in the Fit Lab now), hood, Decart start/stop with countdown, REC, budget/credits.
// Framework-free DOM; every control writes to the StudioBus, every bus change updates the controls.
import type { JacketId, StudioBus } from './contract';
import { formatCountdown } from '../decart/session-timer';

const JACKETS: { id: JacketId; label: string }[] = [
  { id: 'DQ4920-206', label: 'Puffer' },
  { id: 'FB7675-100', label: 'Parka' },
];

export interface Shell {
  /** Where the big video goes (Decart output or the fallback camera). */
  bigSlot: HTMLElement;
  /** Absolutely positioned layer over the big slot (perception/zip overlays). */
  overlayHost: HTMLElement;
  /** The Fit Lab panel mounts here. */
  fitHost: HTMLElement;
  showBig(video: HTMLVideoElement, caption: string, mirror: boolean): void;
  setDecart(text: string, live: boolean, remainingS: number | null): void;
  setBudget(text: string): void;
  setCredits(text: string): void;
  setNote(text: string): void;
  log(message: string, level?: 'info' | 'warn' | 'error'): void;
  onDecartToggle(fn: () => void): void;
  /** Stream for REC (the big slot's current video). */
  setRecordSource(get: () => MediaStream | null): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...children);
  return e;
}

export function createShell(root: HTMLElement, bus: StudioBus): Shell {
  const bigSlot = el('div', { className: 'big-slot' });
  const overlayHost = el('div', { className: 'overlay-host' });
  const caption = el('div', { className: 'big-caption' }, ['starting camera…']);
  const note = el('div', { className: 'big-note' });
  const big = el('section', { className: 'big' }, [bigSlot, overlayHost, caption, note]);
  const fitHost = el('div', { className: 'fit-host' }, [
    el('div', { className: 'placeholder' }, ['Fit Lab loads here (FL).']),
  ]);
  const logBox = el('div', { className: 'log' });
  const side = el('aside', { className: 'side' }, [fitHost, logBox]);

  // ---- bottom bar ----
  const jacketButtons = JACKETS.map((j) =>
    el('button', {
      type: 'button',
      textContent: j.label,
      onclick: () => bus.set({ jacket: j.id }, 'ui'),
    }),
  );
  const zip = el('input', { type: 'range', min: '0', max: '1', step: '0.01', value: '0' });
  zip.addEventListener('input', () => bus.set({ zip: Number(zip.value) }, 'slider'));
  const zipLabel = el('span', { className: 'zip-label' });
  const hood = el('button', {
    type: 'button',
    onclick: () => bus.set({ hoodOn: !bus.get().hoodOn }, 'ui'),
  });
  const decartBtn = el('button', {
    type: 'button',
    className: 'decart',
    textContent: 'Start Decart',
  });
  const decartText = el('span', { className: 'decart-text' });
  const rec = el('button', { type: 'button', className: 'rec', textContent: 'REC' });
  const budget = el('span', { className: 'budget' });
  const credits = el('span', { className: 'credits', textContent: 'Credits left: …' });
  const bar = el('footer', { className: 'bar' }, [
    el('div', { className: 'group' }, jacketButtons),
    el('label', { className: 'group zip' }, ['Zip ', zip, zipLabel]),
    el('div', { className: 'group' }, [hood]),
    el('div', { className: 'group' }, [decartBtn, decartText]),
    el('div', { className: 'group' }, [rec]),
    el('div', { className: 'group' }, [credits]),
    el('div', { className: 'group money' }, [budget]),
  ]);
  root.replaceChildren(el('main', { className: 'studio' }, [big, side]), bar);

  const render = () => {
    const s = bus.get();
    jacketButtons.forEach((b, i) => b.classList.toggle('on', JACKETS[i].id === s.jacket));
    if (document.activeElement !== zip) zip.value = String(s.zip);
    zipLabel.textContent = `${Math.round(s.zip * 100)}% open`;
    hood.textContent = s.hoodOn ? 'Hood: on' : 'Hood: off';
    hood.classList.toggle('on', s.hoodOn);
  };
  bus.subscribe(render);
  render();

  // ---- REC: explicit user export of the big slot's video (webm download), nothing auto-saved ----
  let recordSource: () => MediaStream | null = () => null;
  let recorder: MediaRecorder | null = null;
  rec.addEventListener('click', () => {
    if (recorder) {
      recorder.stop();
      return;
    }
    const stream = recordSource();
    if (!stream) {
      shell.log('REC: nothing to record yet', 'warn');
      return;
    }
    const chunks: Blob[] = [];
    recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);
    recorder.onstop = () => {
      recorder = null;
      rec.classList.remove('on');
      rec.textContent = 'REC';
      const url = URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
      const a = el('a', {
        href: url,
        download: `studio-${Date.now()}.webm`,
        textContent: 'save recording',
      });
      a.addEventListener('click', () => setTimeout(() => URL.revokeObjectURL(url), 5000));
      const line = el('div', {}, ['REC done: ', a]);
      logBox.append(line);
    };
    recorder.start(1000);
    rec.classList.add('on');
    rec.textContent = 'STOP REC';
  });

  const shell: Shell = {
    bigSlot,
    overlayHost,
    fitHost,
    showBig(video, text, mirror) {
      // Mirror the video AND the overlay layer together, so overlays drawn in camera image
      // coordinates (contract: not mirrored) stay on the body.
      big.classList.toggle('mirror', mirror);
      if (video.parentElement !== bigSlot) bigSlot.replaceChildren(video);
      caption.textContent = text;
    },
    setDecart(text, live, remainingS) {
      decartBtn.textContent = live ? 'Stop Decart' : 'Start Decart';
      decartBtn.classList.toggle('live', live);
      decartText.textContent =
        remainingS === null ? text : `${formatCountdown(remainingS)} · ${text}`;
    },
    setBudget: (t) => (budget.textContent = t),
    setCredits: (t) => (credits.textContent = t),
    setNote: (t) => (note.textContent = t),
    log(message, level = 'info') {
      const line = el('div', { className: level }, [
        `${new Date().toTimeString().slice(0, 8)} ${message}`,
      ]);
      logBox.append(line);
      while (logBox.childElementCount > 200) logBox.firstElementChild?.remove();
      logBox.scrollTop = logBox.scrollHeight;
    },
    onDecartToggle: (fn) => decartBtn.addEventListener('click', fn),
    setRecordSource: (get) => (recordSource = get),
  };
  return shell;
}
