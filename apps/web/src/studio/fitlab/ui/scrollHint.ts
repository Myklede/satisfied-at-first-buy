// "Scroll to look inside" hint at the bottom of the 3D view; fades once the user scrolls.
import '../fitlab.css';

export function mountScrollHint(stage: HTMLElement): { hide(): void; dispose(): void } {
  const el = document.createElement('div');
  el.className = 'fl-hint';
  el.innerHTML =
    '<svg viewBox="0 0 16 22" width="12" height="16" aria-hidden="true"><rect x="1" y="1" width="14" height="20" rx="7" fill="none" stroke="currentColor" stroke-width="1.5"/><rect class="fl-hint-wheel" x="7" y="5" width="2" height="5" rx="1" fill="currentColor"/></svg><span>Scroll to look inside</span>';
  stage.append(el);
  const hide = () => el.classList.add('gone');
  stage.addEventListener('wheel', hide, { once: true, passive: true });
  return {
    hide,
    dispose() {
      stage.removeEventListener('wheel', hide);
      el.remove();
    },
  };
}
