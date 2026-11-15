// Content script on Amazon product pages: read the page → ask the local agent → show the panel.
// Body data never enters this script or the Amazon page; it only sees fit outcomes.
import { closePopover, looksLikeSizeTable, openSizeChart, pageAsin, readPage } from './extract';
import { selectSize } from './select';
import type {
  AgentStatus,
  Learning,
  Message,
  PageContent,
  Purchase,
  Recommendation,
  Reply,
  SizeView,
  ZoneView,
} from './types';
import { cmIn } from './units';
import { catalogueStudioUrl } from './bridge';
import { WEB_ORIGIN } from './config';
import { barPosition, rankingBasis, roomValue, zoneStatus, unknownReason } from './fitPresentation';
import { bodyDiagram, type Illustration } from './bodyDiagram';
import { neighbouringSizes } from './comparison';

declare const __FIT_AGENT_DEV__: boolean;

type Child = Node | string | null | undefined | false;

function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

function button(label: string, testid: string, onClick: () => void, kind = ''): HTMLElement {
  const el = h('button', { type: 'button', 'data-testid': testid, class: kind }, label);
  el.addEventListener('click', onClick);
  return el;
}

async function send<T>(message: Message): Promise<Reply<T>> {
  try {
    return await chrome.runtime.sendMessage<Reply<T>>(message);
  } catch {
    return { ok: false, error: { error: 'Extension background is not available', status: 0 } };
  }
}

const STYLE = `
:host { all: initial; }
.panel { position: fixed; right: 16px; bottom: 16px; z-index: 2147483646; width: 380px;
  max-height: 80vh; overflow: auto; background: #fff; color: #0f1111; border: 1px solid #d5d9d9;
  border-radius: 10px; box-shadow: 0 6px 24px rgba(0,0,0,.18); font: 13px/1.4 system-ui, sans-serif; }
header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; background: #232f3e;
  color: #fff; border-radius: 10px 10px 0 0; position: sticky; top: 0; }
header strong { flex: 1; }
section { padding: 10px 12px; border-top: 1px solid #eee; }
.size { font-size: 28px; font-weight: 700; }
.badge { font-size: 11px; padding: 2px 6px; border-radius: 8px; background: #e7f4f5; color: #0f5a63; }
.est { background: #fff4e5; color: #8a4b00; }
button { font: inherit; margin: 4px 4px 0 0; padding: 5px 10px; border-radius: 16px;
  border: 1px solid #d5d9d9; background: #fff; cursor: pointer; }
button.primary { background: #ffd814; border-color: #fcd200; }
button[aria-pressed="true"] { background: #232f3e; color: #fff; }
table { width: 100%; border-collapse: collapse; margin-top: 6px; }
td, th { text-align: left; padding: 3px 4px; border-bottom: 1px solid #f0f0f0; vertical-align: top; }
.fit { color: #067d62; } .tight, .too_big { color: #b12704; } .relaxed { color: #8a6d00; }
.unknown { color: #6b6b6b; }
ol.trace { margin: 4px 0 0 18px; padding: 0; } ol.trace li { margin: 2px 0; }
.done::marker { color: #067d62; } .failed::marker { color: #b12704; }
.muted { color: #565959; font-size: 12px; } .note { color: #565959; font-size: 12px; margin: 2px 0; }
:host { --accent:#a4e3c8; --ink:#eef3f0; --muted:#a9b6b4; --surface:#11181c; }
.panel { width:min(440px,calc(100vw - 24px)); max-height:86vh; background:var(--surface); color:var(--ink); border:1px solid #36444a; border-radius:20px; font:14px/1.5 system-ui,sans-serif; box-shadow:0 16px 60px #0006; }
header { background:var(--surface); color:var(--ink); padding:16px; border-radius:20px 20px 0 0; z-index:2; }
section { padding:16px; border-color:#36444a; }
.size { font-size:64px; line-height:1.1; letter-spacing:-.04em; color:var(--accent); }
button { padding:8px 12px; background:transparent; color:var(--ink); border-color:#637574; min-height:36px; }
button.primary { background:var(--accent); color:#11181c; border-color:var(--accent); }
button:focus-visible, summary:focus-visible, .size-strip:focus-visible { outline:3px solid var(--accent); outline-offset:3px; }
.muted,.note { color:var(--muted); font-size:13px; }
td,th { border-color:#36444a; }
.fit { color:#a4e3c8; } .tight,.too_big { color:#ffa79a; } .relaxed { color:#f2d08b; } .unknown { color:var(--muted); }
.body-map { position:relative; height:180px; margin:12px 0; }
.body-map svg { height:100%; width:100%; fill:#a9b6b422; stroke:var(--muted); }
.body-map button { position:absolute; font-size:12px; padding:3px 8px; background:var(--surface); }
.size-strip { overflow:auto; } .size-strip th,.size-strip td { white-space:nowrap; }
.size-strip td { white-space:normal; min-width:112px; padding:8px; }
.fit-bar { margin:10px 0 16px; } .zone-heading { display:flex; justify-content:space-between; gap:8px; }
.fit-track { position:relative; height:8px; margin:12px 5px 5px; border-radius:8px; background:linear-gradient(90deg,#cf8579 0%,#a4e3c8 47%,#a4e3c8 53%,#d6b77c 100%); }
.fit-track:before { content:""; position:absolute; left:50%; top:-3px; height:14px; width:1px; background:var(--ink); }
.fit-marker { position:absolute; top:-4px; width:14px; height:14px; border:2px solid var(--surface); border-radius:50%; background:currentColor; transform:translateX(-50%); box-shadow:0 0 0 1px currentColor; }
.bar-labels { display:flex; justify-content:space-between; font-size:10px; color:var(--muted); }
.size-strip .zone-heading { display:block; font-size:12px; } .size-strip .zone-heading span { display:block; }
.size-strip .note { font-size:11px; } .size-strip .fit-bar { margin:0; } caption{text-align:left;font-weight:600;margin:12px 0;}
.panel details {padding:12px 16px;border-top:1px solid #36444a;} .panel details details{padding:8px 0;border:0;}
.diagram-card svg { width:100%; height:260px; display:block; }
.body-outline { fill:#a9b6b41a; stroke:var(--muted); stroke-width:1.2; }
.diagram-zone { cursor:pointer; outline:none; } .zone-shape { fill:currentColor; fill-opacity:.2; stroke:currentColor; stroke-width:3; }
.diagram-zone.unknown .zone-shape { fill:none; stroke-dasharray:3 3; stroke-width:1.5; }
.zone-leader { fill:none; stroke:currentColor; stroke-width:.8; } .diagram-zone text { fill:currentColor; font:12px system-ui; }
.diagram-zone .diagram-missing { font-size:10px; } .diagram-zone:focus-visible .zone-shape { stroke-width:5; }
summary { cursor:pointer; font-weight:600; }
@media(prefers-color-scheme:light) { :host { --surface:#f4f8f6; --ink:#172a26; --muted:#4a635c; --accent:#176b50; } .fit{color:#176b50}.tight,.too_big{color:#a83629}.relaxed{color:#795700} button.primary{color:white} }
@media(prefers-reduced-motion:no-preference) { .panel { animation:fit-enter .2s ease-out; } @keyframes fit-enter { from { opacity:0; transform:translateY(6px) } } }
`;

class Panel {
  private revealLearned = false;
  private illustration: Illustration = 'neutral';
  private host = h('div', { id: 'satisfy-fit-agent' });
  private root: ShadowRoot;
  private body = h('div');
  private result: Recommendation | null = null;
  private shownSize: string | null = null;

  constructor(private page: PageContent) {
    // Closed in the shipped build (page scripts cannot reach it); open only in the dev/e2e build.
    this.root = this.host.attachShadow({ mode: __FIT_AGENT_DEV__ ? 'open' : 'closed' });
    const panel = h(
      'div',
      { class: 'panel', 'data-testid': 'fit-agent-panel' },
      h(
        'header',
        {},
        h('strong', {}, 'Satisfy Fit Agent'),
        button('Profile & learning', 'open-profile', () => void send({ op: 'openProfile' })),
      ),
      this.body,
    );
    this.root.append(h('style', {}, STYLE), panel);
    document.documentElement.append(this.host);
  }

  set(...children: Child[]): void {
    this.body.replaceChildren(...children.filter((c): c is Node | string => Boolean(c)));
  }

  async start(): Promise<void> {
    this.set(h('section', { 'data-testid': 'state' }, 'Reading this product page…'));
    const status = await send<AgentStatus>({ op: 'status' });
    if (!status.ok) return this.error(status.error.error);
    this.illustration = status.data.illustration ?? 'neutral';
    const feedback = await this.feedbackSection();
    if (!status.data.profile_saved && !status.data.session_body) {
      this.set(
        feedback,
        h(
          'section',
          { 'data-testid': 'needs-profile' },
          h('p', {}, 'Tell the agent your body once (height, weight; kept on this computer).'),
          button(
            'Set up body profile',
            'setup-profile',
            () => void send({ op: 'openProfile' }),
            'primary',
          ),
        ),
      );
      return;
    }
    await this.recommend(undefined, feedback);
  }

  error(message: string, extra?: Child): void {
    this.set(h('section', { 'data-testid': 'error' }, h('p', {}, message), extra));
  }

  async recommend(override?: 'garment' | 'body', feedback?: Child): Promise<void> {
    const reply = await send<Recommendation>({
      op: 'recommend',
      page: this.page,
      chart_type_override: override,
    });
    if (!reply.ok) {
      const detail = reply.error.detail as
        | { unclear?: boolean; trace?: { detail: string }[] }
        | undefined;
      if (detail?.unclear) {
        if (/unit[^;]*(?:missing|ambiguous|not printed)/i.test(reply.error.error)) {
          return this.error(
            'The chart needs an unambiguous cm or inches label. Open its unit selector and reload with one unit shown. No fit was calculated.',
          );
        }
        this.error(
          'This page does not say whether the chart lists BODY or GARMENT measurements.',
          h(
            'div',
            {},
            button('It is body measurements', 'override-body', () => void this.recommend('body')),
            button(
              'It is garment measurements',
              'override-garment',
              () => void this.recommend('garment'),
            ),
          ),
        );
        return;
      }
      return this.error(reply.error.error);
    }
    this.result = reply.data;
    this.shownSize = reply.data.recommended_size;
    this.render(feedback ?? (await this.feedbackSection()));
  }

  private fitBar(zone: ZoneView, showLabel = true): HTMLElement {
    const value = roomValue(zone);
    const position = barPosition(zone);
    const status = zone.adjusted_status ?? zone.status;
    const track = h('div', {
      class: 'fit-track',
      'aria-label': `${zone.label}: ${zoneStatus(zone)}`,
    });
    if (position !== null) {
      const dot = h('i', { class: `fit-marker ${status}` });
      dot.style.left = `${position}%`;
      track.append(dot);
    }
    return h(
      'div',
      { class: 'fit-bar', 'data-zone': zone.zone },
      h(
        'div',
        { class: 'zone-heading' },
        showLabel ? h('strong', {}, zone.label) : null,
        h('span', { class: status }, zoneStatus(zone)),
      ),
      track,
      h('div', { class: 'bar-labels' }, 'tight', h('span', {}, 'just right'), 'roomy'),
      h(
        'p',
        { class: 'note' },
        value === null ? 'Measurement unavailable' : cmIn(value),
        zone.metric === 'body_chart_distance_cm' ? ' · relative to retailer body range' : '',
        zone.estimated ? ' · estimated' : '',
        zone.zone === 'collar' ? ' · estimated neck; provisional comfort' : '',
        zone.personal_offset_cm ? ' · provisional preference included' : '',
      ),
    );
  }

  private zonesTable(size: SizeView): HTMLElement {
    const known = size.zones.filter((z) => z.value_cm !== null && z.status !== 'unknown');
    const missing = size.zones.filter((z) => z.value_cm === null || z.status === 'unknown');
    return h(
      'div',
      { 'data-testid': 'zones' },
      ...known.map((z) => this.fitBar(z)),
      missing.length
        ? h(
            'p',
            { class: 'note', 'data-testid': 'missing-zones' },
            missing.map((z) => `${z.label.toLowerCase()}: ${unknownReason(z)}`).join('; '),
          )
        : null,
    );
  }

  private bodyMap(size: SizeView): HTMLElement {
    return bodyDiagram(size, this.illustration);
  }

  private sizeStrip(sizes: SizeView[]): HTMLElement {
    const names = [
      ...new Set(
        sizes.flatMap((s) =>
          s.zones.filter((z) => z.value_cm !== null && z.status !== 'unknown').map((z) => z.zone),
        ),
      ),
    ];
    return h(
      'div',
      {
        class: 'size-strip',
        tabindex: '0',
        role: 'region',
        'aria-label': 'Compare size measurements',
      },
      h(
        'table',
        { 'data-testid': 'size-strip' },
        h('caption', {}, 'Compare neighbouring sizes'),
        h('tr', {}, h('th', {}, 'Zone'), ...sizes.map((s) => h('th', {}, s.size))),
        ...names.map((name) =>
          h(
            'tr',
            {},
            h('th', { scope: 'row' }, name),
            ...sizes.map((size) => {
              const zone = size.zones.find(
                (z) => z.zone === name && z.value_cm !== null && z.status !== 'unknown',
              );
              return h(
                'td',
                {},
                zone ? this.fitBar(zone, false) : h('span', { class: 'note' }, 'Not measured'),
              );
            }),
          ),
        ),
      ),
    );
  }

  private render(feedback: Child): void {
    const r = this.result;
    if (!r) return;
    const shown = r.sizes.find((s) => s.size === this.shownSize) ?? r.sizes[0];
    const chosen = r.recommended_size;
    const ex = r.extraction;
    const studio = catalogueStudioUrl(
      r.three_d ? `${WEB_ORIGIN}/?product=${encodeURIComponent(r.three_d.product_id)}` : undefined,
      WEB_ORIGIN,
    );
    const tabs = h(
      'div',
      {},
      ...r.sizes.map((s) => {
        const b = button(s.size, `size-tab-${s.size}`, () => {
          this.shownSize = s.size;
          this.render(feedback);
        });
        b.setAttribute('aria-pressed', String(s.size === shown.size));
        return b;
      }),
    );
    const selectResult = h('span', { 'data-testid': 'select-result', class: 'muted' });
    const actions = h(
      'div',
      {},
      chosen &&
        button(
          `Select size ${chosen} on this page`,
          'select-size',
          () => {
            const result = selectSize(document, chosen);
            selectResult.textContent = result.ok
              ? `Check size ${chosen} on the page (${result.detail}).`
              : result.detail;
          },
          'primary',
        ),
      studio &&
        button(
          'Try in 3D / X-ray',
          'see-3d',
          () =>
            void send({
              op: 'open3d',
              url: `${studio}&size=${encodeURIComponent(chosen ?? shown.size)}`,
            }),
        ),
      button('Add to compare', 'add-compare', () => void this.addCompare()),
      chosen && button(`I bought size ${chosen}`, 'bought', () => void this.bought(chosen)),
      selectResult,
    );
    this.set(
      h(
        'section',
        { 'data-testid': 'recommendation' },
        h('div', { class: 'muted' }, 'Recommended size'),
        h('div', { class: 'size', 'data-testid': 'recommended-size' }, chosen ?? 'no fair pick'),
        h('p', { class: 'note' }, r.explanation[0] ?? 'No supported recommendation.'),
        h(
          'span',
          { class: 'badge', 'data-testid': 'basis' },
          rankingBasis(r) ??
            `${ex.garment_estimated ? 'Body chart · estimated garment' : 'Garment chart'} · ${ex.source_label}`,
        ),
        ...r.explanation.slice(1, 3).map((line) => h('p', { class: 'note' }, line)),
        r.explanation.some((line) => line.includes('Without it we would pick'))
          ? button('Undo last feedback', 'undo-preference', () => void this.undoPreference())
          : null,
        actions,
      ),
      h(
        'section',
        {},
        tabs,
        this.bodyMap(shown),
        this.zonesTable(shown),
        this.sizeStrip(neighbouringSizes(r.sizes, shown.size)),
        studio &&
          h(
            'p',
            { class: 'note' },
            'Your body, this measured jacket, the recommended size and your layer and fit choices open together in the private local studio.',
          ),
        !r.three_d &&
          h(
            'p',
            { class: 'note', 'data-testid': 'no-3d' },
            '3D try-on needs a tape-measured jacket; this one has a chart only.',
          ),
      ),
      h(
        'details',
        { 'data-testid': 'trace' },
        h('summary', {}, 'How I decided'),
        h(
          'ol',
          { class: 'trace' },
          ...r.trace.map((t) =>
            h(
              'li',
              { class: t.status, 'data-step': t.step },
              `${t.step.replace('_', ' ')}: ${t.detail}`,
            ),
          ),
        ),
        h(
          'div',
          { 'data-testid': 'source' },
          h(
            'span',
            { class: 'badge', 'data-testid': 'source-label' },
            `Chart read by: ${ex.source_label}`,
          ),
          ' ',
          h(
            'span',
            { class: `badge ${ex.garment_estimated ? 'est' : ''}` },
            ex.garment_estimated ? 'BODY chart → garment estimated' : 'GARMENT chart',
          ),
          ...ex.notes.map((n) => h('p', { class: 'note' }, n)),
          ...ex.extraction.assumptions.map((n) => h('p', { class: 'note' }, n)),
        ),
      ),
      feedback,
      h('section', { 'data-testid': 'compare' }),
    );
    void this.renderCompare();
  }

  private async undoPreference(): Promise<void> {
    const result = await send<Learning>({ op: 'learning' });
    const latest = result.ok ? result.data.items.at(-1) : undefined;
    if (latest) {
      const undone = await send({ op: 'undo', purchase_id: latest.purchase_id });
      if (undone.ok) await this.recommend();
    }
  }

  private async addCompare(): Promise<void> {
    if (!this.result) return;
    const { compare } = await chrome.storage.local.get('compare');
    const list = ((compare as { asin: string; title: string }[] | undefined) ?? []).filter(
      (c) => c.asin !== this.page.asin,
    );
    list.push({ asin: this.page.asin, title: this.result.title.slice(0, 120) });
    await chrome.storage.local.set({ compare: list.slice(-2) });
    await this.renderCompare();
  }

  private async renderCompare(): Promise<void> {
    const target = this.root.querySelector('[data-testid="compare"]');
    if (!target) return;
    const { compare } = await chrome.storage.local.get('compare');
    const list = (compare as { asin: string; title: string }[] | undefined) ?? [];
    if (list.length < 2) {
      target.replaceChildren(
        h(
          'span',
          { class: 'muted' },
          list.length ? `Compare list: ${list[0].title || list[0].asin} (add one more)` : '',
        ),
      );
      return;
    }
    target.replaceChildren(
      h('strong', {}, 'Compare'),
      h('p', { class: 'muted' }, list.map((c) => c.title || c.asin).join(' vs ')),
      button('Compare these two', 'run-compare', async () => {
        const reply = await send<{ summary: string[]; products: Recommendation[] }>({
          op: 'compare',
          asins: list.map((c) => c.asin),
        });
        if (!reply.ok) {
          target.append(h('p', { class: 'note' }, reply.error.error));
          return;
        }
        const zones = [
          ...new Set(
            reply.data.products.flatMap(
              (p) =>
                p.sizes
                  .find((s) => s.size === p.recommended_size)
                  ?.zones.filter((z) => z.value_cm !== null && z.status !== 'unknown')
                  .map((z) => z.zone) ?? [],
            ),
          ),
        ];
        const pick = (p: Recommendation) => p.sizes.find((s) => s.size === p.recommended_size);
        target.append(
          h(
            'table',
            { 'data-testid': 'compare-table' },
            h(
              'tr',
              {},
              h('th', {}, ''),
              ...reply.data.products.map((p) =>
                h('th', {}, `${(p.title || p.asin).slice(0, 28)} → ${p.recommended_size ?? '—'}`),
              ),
            ),
            ...zones.map((zone) =>
              h(
                'tr',
                {},
                h('td', {}, zone),
                ...reply.data.products.map((p) => {
                  const z = pick(p)?.zones.find((x) => x.zone === zone);
                  return h(
                    'td',
                    { class: z?.status ?? 'unknown' },
                    z && z.value_cm !== null && z.status !== 'unknown'
                      ? this.fitBar(z, false)
                      : 'Not measured',
                  );
                }),
              ),
            ),
          ),
          ...reply.data.products.map((p) =>
            h('p', { class: 'note' }, p.explanation[0] ?? 'No fair pick.'),
          ),
        );
      }),
    );
  }

  private async bought(size: string): Promise<void> {
    const reply = await send<Purchase>({
      op: 'purchase',
      asin: this.page.asin,
      size,
      title: this.page.title,
    });
    if (!reply.ok) {
      this.error(reply.error.error);
      return;
    }
    this.revealLearned = true;
    this.render(await this.feedbackSection());
  }

  private async feedbackSection(): Promise<HTMLElement | null> {
    const reply = await send<Learning>({ op: 'learning' });
    if (!reply.ok) return null;
    const pending = reply.data.purchases.filter((p) => !p.feedback);
    const learned = reply.data.learned;
    if (!pending.length && !learned.length) return null;
    const section = h(
      'details',
      { 'data-testid': 'feedback' },
      h('summary', {}, 'Learned from your feedback · provisional'),
    ) as HTMLDetailsElement;
    section.open = this.revealLearned;
    for (const purchase of pending.slice(-1)) {
      const answers: Record<string, string> = {};
      const zones = Object.entries(purchase.snapshot).filter(
        ([zone, snap]) => zone !== 'collar' && snap.status !== 'unknown',
      );
      section.append(
        h('strong', {}, `How did size ${purchase.size} of ${purchase.title || purchase.asin} fit?`),
        h(
          'table',
          {},
          ...zones.map(([zone]) =>
            h(
              'tr',
              {},
              h('td', {}, zone),
              h(
                'td',
                {},
                ...['tight', 'right', 'loose'].map((answer) => {
                  const b = button(answer, `fb-${zone}-${answer}`, () => {
                    answers[zone] = answer;
                    b.parentElement
                      ?.querySelectorAll('button')
                      .forEach((x) => x.setAttribute('aria-pressed', 'false'));
                    b.setAttribute('aria-pressed', 'true');
                  });
                  return b;
                }),
              ),
            ),
          ),
        ),
        button(
          'Send fit feedback',
          'fb-send',
          async () => {
            if (!Object.keys(answers).length) return;
            const sent = await send<Learning>({
              op: 'feedback',
              purchase_id: purchase.id,
              answers,
            });
            if (sent.ok) {
              this.revealLearned = false;
              await this.recommend();
            }
          },
          'primary',
        ),
      );
    }
    if (learned.length) {
      const history = h(
        'details',
        {},
        h('summary', {}, 'Learned from your feedback'),
        h(
          'p',
          { class: 'note' },
          'Personal offsets use a provisional learning rule, not a measured preference curve. Undo anytime in Profile & learning.',
        ),
        ...learned.map((l) => h('p', { class: 'note', 'data-testid': 'learned' }, l)),
      ) as HTMLDetailsElement;
      history.open = true;
      section.append(history);
    }
    return section;
  }
}

async function main(): Promise<void> {
  if (document.getElementById('satisfy-fit-agent')) return;
  const asin = pageAsin(document, location.href);
  if (!asin) return;
  let page = readPage(document, asin, 'in_dom');
  if (!page.tables.some((t) => looksLikeSizeTable(t.rows))) {
    const opened = await openSizeChart(document);
    page = readPage(document, asin, opened ? 'popover_opened' : 'not_found');
    if (opened) closePopover(document); // read first, then leave the page as it was
  }
  await new Panel(page).start();
}

void main();
