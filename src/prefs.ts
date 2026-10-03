// UI preferences only (open tab ids, layout, font, theme).
// Note titles and contents are NEVER written to browser storage.

export interface Prefs {
  tabs: string[];
  active: string | null;
  sidebar: boolean;
  mono: boolean;
  theme: 'auto' | 'light' | 'dark';
}

const KEY = 'quaderno.prefs.v1';
const DEFAULTS: Prefs = { tabs: [], active: null, sidebar: true, mono: false, theme: 'auto' };

export function loadPrefs(userId: string): Prefs {
  try {
    const raw = localStorage.getItem(`${KEY}.${userId}`);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Prefs>) };
  } catch {
    /* storage unavailable: use defaults */
  }
  return { ...DEFAULTS };
}

export function savePrefs(userId: string, prefs: Prefs): void {
  try {
    localStorage.setItem(`${KEY}.${userId}`, JSON.stringify(prefs));
  } catch {
    /* ignore */
  }
}

export function applyTheme(theme: Prefs['theme']): void {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
