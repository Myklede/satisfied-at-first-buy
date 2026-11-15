// Studio shell: layout + bottom bar (prompts/31). Big slot left (~2/3): Decart when live, else the
// fallback (plain camera + overlay host). Right: the Fit Lab panel host. Bottom bar: jacket picture
// rail, zip slider (size lives in the Fit Lab now), hood, Decart stop with countdown, REC,
// budget/credits. Before the shopper's first pick the big view shows a large jacket chooser; a card
// click only selects the jacket. Decart starts only from the Start Decart button (user 06:49).
// Framework-free DOM; every control writes to the StudioBus, every bus change updates the controls.
import type { JacketId, StudioBus } from './contract';
import { formatCountdown } from '../decart/session-timer';
import { createJacketCards, decartControls } from './jacketCards';

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
  /** Start Decart button (enabled once a jacket is picked and Decart is idle). */
  onDecartStart(fn: () => void): void;
  /** Stop Decart button (live or starting). */
  onDecartStop(fn: () => void): void;
  /** A jacket card was clicked (after the bus was set to it). */
  onJacketPick(fn: (id: JacketId) => void): void;
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
  // ---- jacket cards: large chooser before the first pick, compact rail in the bar after ----
  let picked = false;
  const pickFns: ((id: JacketId) => void)[] = [];
  const pick = (id: JacketId) => {
    bus.set({ jacket: id }, 'ui');
    if (!picked) {
      picked = true;
      chooser.hidden = true;
      railGroup.hidden = false;
    }
    render();
    applyDecartButtons();
    for (const fn of pickFns) fn(id);
  };
  const largeCards = createJacketCards('large', pick);
  const railCards = createJacketCards('thumb', pick);
  const chooser = el('div', { className: 'chooser' }, [
    el('div', { className: 'chooser-inner' }, [
      el('h2', { className: 'chooser-title', textContent: 'Choose a jacket to try on' }),
      el('p', {
        className: 'chooser-sub',
        textContent: 'Tap a jacket. The photoreal try-on starts on your pick.',
      }),
      largeCards.root,
    ]),
  ]);
  const big = el('section', { className: 'big' }, [bigSlot, overlayHost, caption, note, chooser]);
  const fitHost = el('div', { className: 'fit-host' }, [
    el('div', { className: 'placeholder' }, ['Fit Lab loads here (FL).']),
  ]);
  const logBox = el('div', { className: 'log' });
  const side = el('aside', { className: 'side' }, [fitHost, logBox]);

  // ---- bottom bar ----
  const railGroup = el('div', { className: 'group rail', hidden: true }, [railCards.root]);
  const zip = el('input', { type: 'range', min: '0', max: '1', step: '0.01', value: '0' });
  zip.addEventListener('input', () => bus.set({ zip: Number(zip.value) }, 'slider'));
  const zipLabel = el('span', { className: 'zip-label' });
  const hood = el('button', {
    type: 'button',
    onclick: () => bus.set({ hoodOn: !bus.get().hoodOn }, 'ui'),
  });
  const startBtn = el('button', {
    type: 'button',
    className: 'decart',
    textContent: 'Start Decart',
  });
  const stopBtn = el('button', {
    type: 'button',
    className: 'decart-stop',
    textContent: 'Stop Decart',
  });
  let decartActive = false;
  const applyDecartButtons = () => {
    const c = decartControls(picked, decartActive);
    startBtn.disabled = c.startDisabled;
    startBtn.title = c.startTitle;
    stopBtn.disabled = c.stopDisabled;
    stopBtn.classList.toggle('live', decartActive);
  };
  const decartText = el('span', { className: 'decart-text' });
  const rec = el('button', { type: 'button', className: 'rec', textContent: 'REC' });
  const budget = el('span', { className: 'budget' });
  const credits = el('span', { className: 'credits', textContent: 'Credits left: …' });
  const bar = el('footer', { className: 'bar' }, [
    railGroup,
    el('label', { className: 'group zip' }, ['Zip ', zip, zipLabel]),
    el('div', { className: 'group' }, [hood]),
    el('div', { className: 'group' }, [startBtn, stopBtn, decartText]),
    el('div', { className: 'group' }, [rec]),
    el('div', { className: 'group' }, [credits]),
    el('div', { className: 'group money' }, [budget]),
  ]);
  root.replaceChildren(el('main', { className: 'studio' }, [big, side]), bar);

  const render = () => {
    const s = bus.get();
    // No card is highlighted before the shopper's own pick (the bus default is not a choice).
    largeCards.setSelected(picked ? s.jacket : null);
    railCards.setSelected(picked ? s.jacket : null);
    if (document.activeElement !== zip) zip.value = String(s.zip);
    zipLabel.textContent = `${Math.round(s.zip * 100)}% open`;
    hood.textContent = s.hoodOn ? 'Hood: on' : 'Hood: off';
    hood.classList.toggle('on', s.hoodOn);
  };
  bus.subscribe(render);
  render();
  applyDecartButtons();

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
      // Re-inserting a media element does not resume it (the HTML spec pauses a video removed from
      // the document): after Decart stops, the camera froze on its last frame (user, 06:57).
      if (video.paused) void video.play().catch(() => undefined);
      caption.textContent = text;
    },
    setDecart(text, live, remainingS) {
      decartActive = live;
      applyDecartButtons();
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
    onDecartStart: (fn) => startBtn.addEventListener('click', fn),
    onDecartStop: (fn) => stopBtn.addEventListener('click', fn),
    onJacketPick: (fn) => pickFns.push(fn),
    setRecordSource: (get) => (recordSource = get),
  };
  return shell;
}
