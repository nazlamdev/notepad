type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown> | null;

/** Tiny hyperscript helper: h('button', { class: 'x', onclick }, 'Label'). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
      else if (k in el && !k.includes('-')) (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** Format a shortcut like "mod+shift+P" for the current platform. */
export function kbd(spec: string): string {
  const map: Record<string, string> = isMac
    ? { mod: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃', enter: '↩', backspace: '⌫', left: '←', right: '→', up: '↑', down: '↓' }
    : { mod: 'Ctrl', shift: 'Maiusc', alt: 'Alt', ctrl: 'Ctrl', enter: 'Invio', backspace: 'Backspace', left: '←', right: '→', up: '↑', down: '↓' };
  return spec
    .split(' ')
    .map((chord) => chord.split('+').map((p) => map[p.toLowerCase()] ?? p.toUpperCase()).join(isMac ? '' : '+'))
    .join(' ');
}

const ICONS: Record<string, string> = {
  compose: '<path d="M11 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/><path d="M18.4 2.6a2 2 0 0 1 2.9 2.9L12 14.8 8 16l1.2-4Z"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="m6 7 1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4h6v3"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  back: '<path d="m15 18-6-6 6-6"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  more: '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="16" cy="12" r="1" fill="currentColor" stroke="none"/>',
  logout: '<path d="M9 4H6a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h3"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  checklist: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  warning: '<path d="M12 3 2 20h20Z"/><path d="M12 10v4"/><circle cx="12" cy="17" r=".8" fill="currentColor"/>',
};

export function icon(name: keyof typeof ICONS | string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] ?? ''}</svg>`;
  return span;
}

export function iconButton(name: string, label: string, onclick: () => void, extraClass = ''): HTMLButtonElement {
  return h('button', { type: 'button', class: `icon-btn ${extraClass}`.trim(), title: label, 'aria-label': label, onclick }, icon(name));
}
