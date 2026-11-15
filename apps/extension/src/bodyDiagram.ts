import type { SizeView } from './types';
import { cmIn } from './units';
import { roomValue, zoneStatus, unknownReason } from './fitPresentation';

export type Illustration = 'male' | 'female' | 'neutral';
const ns = 'http://www.w3.org/2000/svg';
// Hand-drawn illustration coordinates, never measurements or a personalised scan.
export function silhouette(sex: Illustration): string {
  const left =
    sex === 'female' ? 'C117 139 126 153 119 174 Q107 196 112 215' : 'L119 173 Q116 196 120 215';
  const right =
    sex === 'female' ? 'Q193 196 181 174 C174 153 183 139 187 128' : 'Q193 197 188 179 L187 128';
  return `M149 25 C137 25 130 35 131 49 Q132 63 140 67 L139 77 Q113 80 104 94 L77 162 Q72 177 80 181 Q88 184 94 170 L113 128 ${left} L121 277 Q121 291 132 291 Q143 291 143 277 L150 226 L157 277 Q157 291 168 291 Q179 291 179 277 L188 215 ${right} L206 170 Q212 184 220 181 Q228 177 223 162 L196 94 Q187 80 161 77 L160 67 Q168 63 169 49 C170 35 163 25 149 25 Z`;
}

const zones = [
  { name: 'shoulder', path: 'M111 95 L132 84 M168 84 L189 95', anchor: [113, 94], label: [33, 80] },
  {
    name: 'chest',
    path: 'M116 113 Q150 103 184 113 L184 124 Q150 114 116 124 Z',
    anchor: [118, 119],
    label: [22, 121],
  },
  { name: 'waist', path: 'M120 158 Q150 152 180 158', anchor: [180, 158], label: [233, 154] },
  { name: 'hip', path: 'M120 198 Q150 208 188 198', anchor: [123, 198], label: [24, 213] },
  { name: 'sleeve', path: 'M195 103 L216 165', anchor: [208, 141], label: [241, 121] },
  { name: 'hem', path: 'M120 215 L188 215', anchor: [186, 215], label: [226, 233] },
  {
    name: 'collar',
    path: 'M138 74 Q150 85 162 74 Q163 67 150 66 Q137 67 138 74 Z',
    anchor: [161, 71],
    label: [223, 55],
  },
] as const;

export function bodyDiagram(size: SizeView, sex: Illustration): HTMLElement {
  const box = document.createElement('div');
  box.className = 'diagram-card';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 300 310');
  svg.dataset.testid = 'body-map';
  svg.setAttribute('aria-label', 'Illustrative body fit diagram');
  const outline = document.createElementNS(ns, 'path');
  outline.setAttribute('d', silhouette(sex));
  outline.setAttribute('class', 'body-outline');
  svg.append(outline);
  const info = document.createElement('p');
  info.className = 'note';
  info.setAttribute('aria-live', 'polite');
  info.textContent = 'Tap a highlighted zone to explore its fit.';
  for (const item of zones) {
    const zone = size.zones.find((z) => z.zone === item.name),
      known = zone && zone.value_cm !== null && zone.status !== 'unknown';
    const status = known ? (zone.adjusted_status ?? zone.status) : 'unknown';
    const detail = known
      ? `${zone.label}: ${zoneStatus(zone)}, ${cmIn(roomValue(zone)!)}${zone.estimated ? ' · estimated' : ''}`
      : `${item.name}: ${unknownReason(zone)}`;
    const group = document.createElementNS(ns, 'g');
    group.setAttribute('role', 'button');
    group.setAttribute('tabindex', '0');
    group.setAttribute('aria-label', detail);
    group.dataset.testid = `map-${item.name}`;
    group.setAttribute('class', `diagram-zone ${status}`);
    const title = document.createElementNS(ns, 'title');
    title.textContent = detail;
    group.append(title);
    const mark = document.createElementNS(ns, 'path');
    mark.setAttribute('d', item.path);
    mark.setAttribute('class', 'zone-shape');
    group.append(mark);
    const leader = document.createElementNS(ns, 'path');
    leader.setAttribute(
      'd',
      `M${item.anchor[0]} ${item.anchor[1]} L${item.label[0] + (item.label[0] < 100 ? 35 : 0)} ${item.label[1]}`,
    );
    leader.setAttribute('class', 'zone-leader');
    group.append(leader);
    const label = document.createElementNS(ns, 'text');
    label.setAttribute('x', String(item.label[0]));
    label.setAttribute('y', String(item.label[1] - 3));
    label.textContent = item.name;
    group.append(label);
    if (!known) {
      const missing = document.createElementNS(ns, 'text');
      missing.setAttribute('x', String(item.label[0]));
      missing.setAttribute('y', String(item.label[1] + 9));
      missing.setAttribute('class', 'diagram-missing');
      missing.textContent =
        unknownReason(zone) === 'not in chart' ? 'not in chart' : 'inner fit unknown';
      group.append(missing);
    }
    const reveal = () => {
      info.textContent = detail;
    };
    group.addEventListener('click', reveal);
    group.addEventListener('mouseenter', reveal);
    group.addEventListener('focus', reveal);
    group.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        reveal();
      }
    });
    svg.append(group);
  }
  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = 'Illustration, not your scan';
  box.append(svg, info, note);
  return box;
}
