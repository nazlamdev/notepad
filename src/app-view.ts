import type { AdminApi } from './access';
import { createAdminPanel, type AdminPanel } from './admin-view';
import { escapeHtml, h, icon, iconButton, isMac, kbd } from './dom';
import * as ed from './editor-commands';
import { firstLine, groupLabel, listDate, longDate } from './format';
import { fuzzy, highlight } from './fuzzy';
import type { Note, NotesStore, StoreEvent } from './notes-store';
import { applyTheme, loadPrefs, savePrefs } from './prefs';

export interface AppContext {
  store: NotesStore;
  userId: string;
  email: string;
  signOut: () => Promise<void>;
  /** Present only for the administrator: enables the Root tab. */
  admin?: AdminApi;
}

interface Command {
  id: string;
  label: string;
  keys?: string;
  run: () => void;
  when?: () => boolean;
}

interface PaletteItem {
  label: string;
  detail?: string;
  keys?: string;
  indices: number[];
  run: () => void;
}

type Part = 'list' | 'tabs' | 'status' | 'conflict' | 'connection';

const MOBILE = window.matchMedia('(max-width: 760px)');
const supportsFieldSizing = CSS.supports('field-sizing', 'content');

export function mountApp(root: HTMLElement, ctx: AppContext): () => void {
  const { store } = ctx;
  const prefs = loadPrefs(ctx.userId);
  applyTheme(prefs.theme);
  const persist = () => savePrefs(ctx.userId, prefs);
  const cleanups: Array<() => void> = [];
  const listen = <K extends keyof WindowEventMap>(target: Window | Document, type: K | 'visibilitychange', fn: (e: WindowEventMap[K]) => void, opts?: AddEventListenerOptions) => {
    target.addEventListener(type, fn as EventListener, opts);
    cleanups.push(() => target.removeEventListener(type, fn as EventListener, opts));
  };

  let query = '';
  let showCompare = false;
  let rootOpen = false;
  let adminPanel: AdminPanel | null = null;

  // ------------------------------------------------------------------ skeleton

  const countEl = h('span', { class: 'note-count' });
  const searchInput = h('input', { type: 'search', class: 'search-input', placeholder: 'Cerca', 'aria-label': 'Cerca in tutte le note', autocomplete: 'off' });
  const listEl = h('nav', { class: 'note-list', 'aria-label': 'Elenco note' });
  const connDot = h('span', { class: 'conn-dot', role: 'img' });

  const sidebar = h(
    'aside',
    { class: 'sidebar' },
    h(
      'header',
      { class: 'sidebar-header' },
      h('div', { class: 'sidebar-title' }, h('h1', null, 'Note'), countEl),
      iconButton('compose', `Nuova nota (${kbd('mod+alt+n')})`, () => void newNote(), 'accent'),
    ),
    h('div', { class: 'search-wrap' }, icon('search'), searchInput),
    listEl,
    h(
      'footer',
      { class: 'sidebar-footer' },
      connDot,
      h('span', { class: 'user-email', title: ctx.email }, ctx.email),
      ctx.admin ? iconButton('shield', 'Root: richieste di accesso', () => openRoot(), 'root-btn') : null,
      iconButton('logout', 'Esci', () => void logout()),
    ),
  );

  const tabsEl = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Note aperte' });
  const statusEl = h('span', { class: 'save-status', role: 'status', 'aria-live': 'polite' });
  const deleteBtn = iconButton('trash', `Elimina nota (${kbd('mod+shift+backspace')})`, () => void deleteNote(prefs.active));
  const checklistBtn = iconButton('checklist', `Checklist (${kbd('mod+shift+l')})`, () => withBody(ed.toggleChecklist));
  const toolbar = h(
    'header',
    { class: 'toolbar' },
    iconButton('back', 'Elenco note', () => showList(), 'only-mobile'),
    iconButton('sidebar', `Mostra/nascondi elenco (${kbd('mod+b')})`, () => toggleSidebar(), 'hide-mobile'),
    tabsEl,
    statusEl,
    checklistBtn,
    deleteBtn,
    iconButton('compose', 'Nuova nota', () => void newNote(), 'only-mobile accent'),
    iconButton('more', `Comandi (${kbd('mod+shift+p')})`, () => openPalette('commands')),
  );

  const conflictEl = h('div', { class: 'conflict-banner', role: 'alert', hidden: true });

  const findInput = h('input', { type: 'search', class: 'find-input', placeholder: 'Trova nella nota', 'aria-label': 'Trova nella nota', autocomplete: 'off' });
  const findCount = h('span', { class: 'find-count' });
  const findCase = h('button', { type: 'button', class: 'find-toggle', title: 'Maiuscole/minuscole', 'aria-pressed': 'false' }, 'Aa');
  const findBar = h(
    'div',
    { class: 'find-bar', hidden: true },
    icon('search'),
    findInput,
    findCount,
    findCase,
    iconButton('up', `Precedente (${kbd('mod+shift+g')})`, () => findStep(-1)),
    iconButton('down', `Successivo (${kbd('mod+g')})`, () => findStep(1)),
    iconButton('close', 'Chiudi (Esc)', () => closeFind(true)),
  );

  const dateEl = h('div', { class: 'note-date' });
  const titleInput = h('input', { class: 'note-title', placeholder: 'Titolo', 'aria-label': 'Titolo della nota', maxLength: 500, autocomplete: 'off' });
  const mirror = h('div', { class: 'note-text mirror', 'aria-hidden': 'true' });
  const body = h('textarea', { class: 'note-text note-body', placeholder: 'Inizia a scrivere…', 'aria-label': 'Contenuto della nota', spellcheck: true });
  const editorScroll = h('div', { class: 'editor-scroll' }, h('div', { class: 'editor' }, dateEl, titleInput, h('div', { class: 'body-wrap' }, mirror, body)));
  const emptyEl = h(
    'div',
    { class: 'empty' },
    h('div', { class: 'empty-mark', 'aria-hidden': 'true' }),
    h('p', null, 'Nessuna nota selezionata'),
    h('button', { type: 'button', class: 'btn primary', onclick: () => void newNote() }, 'Nuova nota'),
    h('p', { class: 'muted small' }, `${kbd('mod+p')} apri nota · ${kbd('mod+shift+p')} comandi`),
  );

  const adminHost = h('div', { class: 'admin-host', hidden: true });
  const main = h('main', { class: 'main' }, toolbar, conflictEl, findBar, editorScroll, emptyEl, adminHost);
  const app = h('div', { class: 'app' }, sidebar, main);

  const pInput = h('input', { class: 'palette-input', 'aria-label': 'Cerca', autocomplete: 'off', spellcheck: false });
  const pList = h('div', { class: 'palette-list', role: 'listbox' });
  const palette = h('div', { class: 'palette-backdrop', hidden: true }, h('div', { class: 'palette', role: 'dialog', 'aria-label': 'Palette' }, pInput, pList));

  const dialog = h('dialog', { class: 'dialog' });
  const toastEl = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite', hidden: true });

  root.replaceChildren(app, palette, dialog, toastEl);

  // -------------------------------------------------------------- render queue

  const dirtyParts = new Set<Part>();
  let frame = 0;
  const schedule = (...parts: Part[]) => {
    parts.forEach((p) => dirtyParts.add(p));
    if (!frame)
      frame = requestAnimationFrame(() => {
        frame = 0;
        const parts = [...dirtyParts];
        dirtyParts.clear();
        if (parts.includes('list')) renderList();
        if (parts.includes('tabs')) renderTabs();
        if (parts.includes('status')) renderStatus();
        if (parts.includes('conflict')) renderConflict();
        if (parts.includes('connection')) renderConnection();
      });
  };

  // --------------------------------------------------------------------- list

  function filtered(): Note[] {
    const notes = store.all();
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return notes;
    return notes.filter((n) => {
      const hay = `${n.title}\n${n.content}`.toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }

  function snippet(n: Note): Node {
    const q = query.trim().split(/\s+/)[0]?.toLowerCase();
    const text = n.content.replace(/\s+/g, ' ');
    const idx = q ? text.toLowerCase().indexOf(q) : -1;
    if (idx === -1) return document.createTextNode(firstLine(n.content.split('\n').slice(n.content.trim().startsWith(n.title) ? 1 : 0).join('\n')) || 'Nessun testo aggiuntivo');
    const start = Math.max(0, idx - 20);
    const frag = document.createDocumentFragment();
    frag.append((start > 0 ? '…' : '') + text.slice(start, idx), h('mark', null, text.slice(idx, idx + q!.length)), text.slice(idx + q!.length, idx + 120));
    return frag;
  }

  function renderList() {
    const notes = filtered();
    countEl.textContent = query ? `${notes.length} di ${store.size}` : `${store.size} ${store.size === 1 ? 'nota' : 'note'}`;
    const frag = document.createDocumentFragment();
    if (!store.size) {
      frag.append(h('div', { class: 'list-empty' }, h('p', null, 'Ancora nessuna nota.'), h('button', { type: 'button', class: 'btn', onclick: () => void newNote() }, 'Crea la prima nota')));
    } else if (!notes.length) {
      frag.append(h('div', { class: 'list-empty' }, h('p', null, `Nessun risultato per “${query}”.`)));
    }
    let group = '';
    for (const n of notes) {
      const ms = Math.max(Date.parse(n.server.updated_at), n.touchedAt);
      const g = groupLabel(ms);
      if (g !== group) {
        group = g;
        frag.append(h('h2', { class: 'list-group' }, g));
      }
      const state = store.state(n);
      frag.append(
        h(
          'button',
          {
            type: 'button',
            class: `note-item${n.id === prefs.active && !rootOpen ? ' active' : ''}`,
            'data-id': n.id,
            'aria-current': n.id === prefs.active && !rootOpen ? 'true' : null,
            onclick: () => openNote(n.id),
            ondblclick: () => focusTitle(),
          },
          h('span', { class: 'ni-title' }, n.title.trim() || 'Senza titolo', state === 'conflict' || state === 'error' ? h('span', { class: 'ni-flag', title: 'Richiede attenzione' }, '!') : null),
          h('span', { class: 'ni-meta' }, h('span', { class: 'ni-date' }, listDate(ms)), h('span', { class: 'ni-preview' }, snippet(n))),
        ),
      );
    }
    listEl.replaceChildren(frag);
  }

  listEl.addEventListener('keydown', (e) => {
    const items = [...listEl.querySelectorAll<HTMLButtonElement>('.note-item')];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))];
      next?.focus();
      if (next && !MOBILE.matches) openNote(next.dataset.id!, false);
    } else if (e.key === 'Enter' && i >= 0) {
      e.preventDefault();
      openNote(items[i].dataset.id!);
    }
  });

  searchInput.addEventListener('input', () => {
    query = searchInput.value;
    schedule('list');
  });
  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      listEl.querySelector<HTMLButtonElement>('.note-item')?.focus();
    } else if (e.key === 'Enter') {
      const first = listEl.querySelector<HTMLButtonElement>('.note-item');
      if (first) openNote(first.dataset.id!);
    } else if (e.key === 'Escape' && searchInput.value) {
      e.stopPropagation();
      searchInput.value = '';
      query = '';
      schedule('list');
    }
  });

  // --------------------------------------------------------------------- tabs

  function renderTabs() {
    prefs.tabs = prefs.tabs.filter((id) => store.get(id));
    const rootTab = ctx.admin
      ? h(
          'div',
          { class: `tab root-tab${rootOpen ? ' active' : ''}`, role: 'tab', 'aria-selected': String(rootOpen), title: 'Root: richieste di accesso', onclick: () => openRoot() },
          icon('shield'),
          h('span', { class: 'tab-title' }, 'Root'),
          adminPanel?.pending ? h('span', { class: 'tab-badge', 'aria-label': `${adminPanel.pending} richieste in attesa` }, String(adminPanel.pending)) : null,
        )
      : null;
    tabsEl.replaceChildren(
      ...(rootTab ? [rootTab] : []),
      ...prefs.tabs.map((id) => {
        const n = store.get(id)!;
        const active = id === prefs.active && !rootOpen;
        const state = store.state(n);
        return h(
          'div',
          {
            class: `tab${active ? ' active' : ''}${state !== 'saved' ? ` ${state}` : ''}`,
            role: 'tab',
            'aria-selected': String(active),
            title: n.title,
            onclick: () => openNote(id),
            onauxclick: (e: MouseEvent) => e.button === 1 && closeTab(id),
          },
          h('span', { class: 'tab-title' }, n.title.trim() || 'Senza titolo'),
          h(
            'button',
            {
              type: 'button',
              class: 'tab-close',
              'aria-label': `Chiudi ${n.title}`,
              onclick: (e: MouseEvent) => {
                e.stopPropagation();
                closeTab(id);
              },
            },
            icon('close'),
          ),
        );
      }),
    );
    tabsEl.querySelector('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  // ------------------------------------------------------------------- editor

  function activeNote(): Note | undefined {
    return rootOpen ? undefined : store.get(prefs.active);
  }

  function openRoot() {
    if (!ctx.admin) return;
    if (!adminPanel) return;
    rootOpen = true;
    closeFind(false);
    if (!adminHost.firstChild) adminHost.append(adminPanel.el);
    app.classList.add('mobile-editor');
    loadEditor();
    void adminPanel.refresh();
  }

  function closeRoot() {
    if (!rootOpen) return;
    rootOpen = false;
    loadEditor();
  }

  function autosize() {
    if (supportsFieldSizing) return;
    const top = editorScroll.scrollTop;
    body.style.height = 'auto';
    body.style.height = `${body.scrollHeight}px`;
    editorScroll.scrollTop = top;
  }

  function loadEditor() {
    const n = activeNote();
    app.classList.toggle('has-note', !!n);
    editorScroll.hidden = !n;
    emptyEl.hidden = !!n || rootOpen;
    adminHost.hidden = !rootOpen;
    deleteBtn.disabled = checklistBtn.disabled = !n;
    showCompare = false;
    if (n) {
      titleInput.value = n.title;
      body.value = n.content;
      dateEl.textContent = longDate(Date.parse(n.server.updated_at));
      editorScroll.scrollTop = 0;
      autosize();
    }
    if (findOpen) refreshFind();
    schedule('status', 'conflict', 'tabs', 'list');
  }

  function openNote(id: string, focus = true) {
    if (!store.get(id)) return;
    if (!prefs.tabs.includes(id)) {
      const at = prefs.active ? prefs.tabs.indexOf(prefs.active) + 1 : prefs.tabs.length;
      prefs.tabs.splice(at || prefs.tabs.length, 0, id);
    }
    if (prefs.active !== id || rootOpen) {
      prefs.active = id;
      rootOpen = false;
      loadEditor();
    }
    persist();
    app.classList.add('mobile-editor');
    if (focus && !MOBILE.matches) body.focus();
    schedule('tabs', 'list');
  }

  function closeTab(id: string | null) {
    if (!id) return;
    const idx = prefs.tabs.indexOf(id);
    if (idx === -1) return;
    prefs.tabs.splice(idx, 1);
    if (prefs.active === id) {
      prefs.active = prefs.tabs[Math.min(idx, prefs.tabs.length - 1)] ?? null;
      loadEditor();
    }
    persist();
    schedule('tabs', 'list');
  }

  function cycleTab(dir: 1 | -1) {
    if (!prefs.tabs.length) return;
    const i = prefs.active ? prefs.tabs.indexOf(prefs.active) : -1;
    openNote(prefs.tabs[(i + dir + prefs.tabs.length) % prefs.tabs.length]);
  }

  function showList() {
    app.classList.remove('mobile-editor');
    body.blur();
  }

  function toggleSidebar() {
    prefs.sidebar = !prefs.sidebar;
    app.classList.toggle('sidebar-hidden', !prefs.sidebar);
    persist();
  }

  function focusTitle() {
    if (!activeNote()) return;
    app.classList.add('mobile-editor');
    titleInput.focus();
    titleInput.select();
  }

  function withBody(fn: (ta: HTMLTextAreaElement) => void) {
    if (activeNote()) fn(body);
  }

  titleInput.addEventListener('input', () => {
    const n = activeNote();
    if (n) store.edit(n.id, { title: titleInput.value });
  });
  titleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === 'ArrowDown') {
      e.preventDefault();
      body.focus();
      body.setSelectionRange(0, 0);
    } else if (e.key === 'Escape') body.focus();
  });
  titleInput.addEventListener('blur', () => {
    const n = activeNote();
    if (n && !n.title.trim()) {
      titleInput.value = 'Senza titolo';
      store.edit(n.id, { title: 'Senza titolo' });
    }
  });

  body.addEventListener('input', () => {
    const n = activeNote();
    if (!n) return;
    store.edit(n.id, { content: body.value });
    autosize();
    if (findOpen) refreshFind(false);
  });

  body.addEventListener('keydown', (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    const code = e.code;
    const handled = (fn: () => void) => {
      e.preventDefault();
      fn();
    };
    if (e.key === 'Tab' && !mod && !e.altKey && !e.ctrlKey) return handled(() => (e.shiftKey ? ed.outdent(body) : ed.indent(body)));
    if (e.key === 'Enter' && !mod && !e.shiftKey && !e.altKey && !e.isComposing) {
      if (ed.smartEnter(body)) e.preventDefault();
      return;
    }
    if (mod && e.key === 'Enter') return handled(() => ed.insertLine(body, e.shiftKey));
    if (mod && !e.altKey && code === 'BracketRight') return handled(() => ed.indentLines(body));
    if (mod && !e.altKey && code === 'BracketLeft') return handled(() => ed.outdent(body));
    if (mod && e.shiftKey && code === 'KeyD') return handled(() => ed.duplicateLine(body));
    if (mod && e.shiftKey && code === 'KeyK') return handled(() => ed.deleteLine(body));
    if (mod && e.shiftKey && code === 'KeyL') return handled(() => ed.toggleChecklist(body));
    if (mod && e.shiftKey && code === 'KeyU') return handled(() => ed.toggleChecked(body));
    if (mod && !e.shiftKey && code === 'KeyL') return handled(() => ed.selectLine(body));
    const moveCombo = isMac ? e.metaKey && e.ctrlKey : e.ctrlKey && e.shiftKey;
    if (moveCombo && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) return handled(() => ed.moveLines(body, e.key === 'ArrowUp' ? -1 : 1));
  });

  if (!supportsFieldSizing) {
    const ro = new ResizeObserver(() => autosize());
    ro.observe(editorScroll);
    cleanups.push(() => ro.disconnect());
  }

  function applyRemoteToEditor() {
    const n = activeNote();
    if (!n) return;
    if (titleInput.value !== n.title) titleInput.value = n.title;
    if (body.value !== n.content) {
      const { selectionStart: s, selectionEnd: e } = body;
      body.value = n.content;
      const len = n.content.length;
      body.setSelectionRange(Math.min(s, len), Math.min(e, len));
      autosize();
      if (findOpen) refreshFind(false);
    }
    dateEl.textContent = longDate(Date.parse(n.server.updated_at));
  }

  // ------------------------------------------------------------ status/conflict

  function renderStatus() {
    const n = activeNote();
    const state = n ? store.state(n) : null;
    const labels = { saved: 'Salvato', saving: 'Salvataggio…', error: 'Errore', conflict: 'Conflitto' } as const;
    statusEl.className = `save-status ${state ?? ''}`;
    statusEl.textContent = state ? labels[state] : '';
    statusEl.title = n?.error ?? (state === 'conflict' ? 'La nota è stata modificata altrove' : '');
    if (n && state === 'saved') dateEl.textContent = longDate(Date.parse(n.server.updated_at));
  }

  function renderConflict() {
    const n = activeNote();
    const c = n?.conflict;
    conflictEl.hidden = !c;
    if (!n || !c) {
      conflictEl.replaceChildren();
      return;
    }
    const busyWrap = (fn: () => Promise<unknown> | void) => async () => {
      conflictEl.querySelectorAll('button').forEach((b) => (b.disabled = true));
      try {
        await fn();
      } catch (e) {
        toast(e instanceof Error ? e.message : String(e), 'error');
        schedule('conflict');
      }
    };
    if (c.kind === 'updated') {
      conflictEl.replaceChildren(
        h(
          'div',
          { class: 'conflict-head' },
          icon('warning'),
          h(
            'div',
            null,
            h('strong', null, 'Questa nota è stata modificata su un altro dispositivo.'),
            h('p', null, `Le tue modifiche locali non sono ancora state salvate. Versione remota delle ${new Date(c.row.updated_at).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}. Scegli quale tenere:`),
          ),
        ),
        h(
          'div',
          { class: 'conflict-actions' },
          h('button', { type: 'button', class: 'btn primary', onclick: busyWrap(() => store.keepLocal(n.id)) }, 'Mantieni la mia versione'),
          h('button', { type: 'button', class: 'btn', onclick: busyWrap(() => store.keepRemote(n.id)) }, 'Usa la versione remota'),
          h(
            'button',
            {
              type: 'button',
              class: 'btn',
              onclick: busyWrap(async () => {
                const copy = await store.keepBoth(n.id);
                if (copy) toast('La tua versione è stata salvata come nuova nota.');
              }),
            },
            'Tienile entrambe',
          ),
          h(
            'button',
            {
              type: 'button',
              class: 'btn ghost',
              'aria-expanded': String(showCompare),
              onclick: () => {
                showCompare = !showCompare;
                renderConflict();
              },
            },
            showCompare ? 'Nascondi remota' : 'Mostra remota',
          ),
        ),
        ...(showCompare ? [h('div', { class: 'compare' }, h('div', { class: 'compare-title' }, c.row.title), h('pre', null, c.row.content || '(vuota)'))] : []),
      );
    } else {
      conflictEl.replaceChildren(
        h(
          'div',
          { class: 'conflict-head' },
          icon('warning'),
          h('div', null, h('strong', null, 'Questa nota è stata eliminata su un altro dispositivo.'), h('p', null, 'Hai modifiche non salvate. Vuoi ripristinarla con le tue modifiche?')),
        ),
        h(
          'div',
          { class: 'conflict-actions' },
          h('button', { type: 'button', class: 'btn primary', onclick: busyWrap(() => store.keepLocal(n.id)) }, 'Ripristina con le mie modifiche'),
          h('button', { type: 'button', class: 'btn danger', onclick: busyWrap(() => store.keepRemote(n.id)) }, 'Elimina definitivamente'),
        ),
      );
    }
  }

  function renderConnection() {
    const s = store.connection;
    connDot.className = `conn-dot ${s}`;
    const label = { live: 'Sincronizzazione attiva', connecting: 'Connessione in corso…', offline: 'Sincronizzazione non disponibile: riconnessione…' }[s];
    connDot.title = label;
    connDot.setAttribute('aria-label', label);
  }

  // --------------------------------------------------------------------- find

  let findOpen = false;
  let findMatches: number[] = [];
  let findIndex = -1;
  let findCaseSensitive = false;

  function computeMatches() {
    const q = findInput.value;
    findMatches = [];
    if (!q) return;
    const text = findCaseSensitive ? body.value : body.value.toLowerCase();
    const needle = findCaseSensitive ? q : q.toLowerCase();
    for (let i = text.indexOf(needle); i !== -1 && findMatches.length < 5000; i = text.indexOf(needle, i + needle.length)) findMatches.push(i);
  }

  function renderMirror() {
    const q = findInput.value;
    if (!findOpen || !q || !findMatches.length) {
      mirror.innerHTML = '';
      return;
    }
    const v = body.value;
    let html = '';
    let last = 0;
    findMatches.forEach((m, i) => {
      html += escapeHtml(v.slice(last, m)) + `<mark${i === findIndex ? ' class="current"' : ''}>${escapeHtml(v.slice(m, m + q.length))}</mark>`;
      last = m + q.length;
    });
    mirror.innerHTML = html + escapeHtml(v.slice(last)) + '\n';
  }

  function refreshFind(reselect = true) {
    computeMatches();
    if (reselect || findIndex >= findMatches.length) {
      const caret = body.selectionStart;
      findIndex = findMatches.length ? Math.max(0, findMatches.findIndex((m) => m >= caret)) : -1;
    }
    findCount.textContent = findInput.value ? (findMatches.length ? `${findIndex + 1} di ${findMatches.length}` : 'Nessun risultato') : '';
    renderMirror();
  }

  function selectMatch() {
    if (findIndex < 0) return;
    const m = findMatches[findIndex];
    body.setSelectionRange(m, m + findInput.value.length);
    findCount.textContent = `${findIndex + 1} di ${findMatches.length}`;
    renderMirror();
    mirror.querySelector('mark.current')?.scrollIntoView({ block: 'center' });
  }

  function findStep(dir: 1 | -1) {
    if (!findOpen) openFind();
    if (!findMatches.length) return;
    findIndex = (findIndex + dir + findMatches.length) % findMatches.length;
    selectMatch();
  }

  function openFind() {
    if (!activeNote()) return;
    findOpen = true;
    findBar.hidden = false;
    const sel = body.value.slice(body.selectionStart, body.selectionEnd);
    if (sel && !sel.includes('\n')) findInput.value = sel;
    findInput.focus();
    findInput.select();
    refreshFind();
  }

  function closeFind(focusBody: boolean) {
    if (!findOpen) return;
    findOpen = false;
    findBar.hidden = true;
    mirror.innerHTML = '';
    if (focusBody) body.focus();
  }

  findInput.addEventListener('input', () => {
    refreshFind();
    if (findMatches.length) selectMatch();
  });
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      findStep(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeFind(true);
    }
  });
  findCase.addEventListener('click', () => {
    findCaseSensitive = !findCaseSensitive;
    findCase.setAttribute('aria-pressed', String(findCaseSensitive));
    refreshFind();
  });

  // ------------------------------------------------------------------ actions

  async function newNote() {
    try {
      const id = await store.create();
      openNote(id, false);
      focusTitle();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Impossibile creare la nota.', 'error');
    }
  }

  async function deleteNote(id: string | null) {
    const n = store.get(id);
    if (!n) return;
    const ok = await confirmDialog('Eliminare la nota?', `“${n.title.trim() || 'Senza titolo'}” verrà eliminata da tutti i dispositivi. L’operazione non si può annullare.`, 'Elimina', true);
    if (!ok) return;
    try {
      await store.remove(n.id);
      toast('Nota eliminata.');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Impossibile eliminare la nota.', 'error');
    }
  }

  async function saveNow() {
    await store.flushAll();
    const n = activeNote();
    if (n?.error) toast(n.error, 'error');
  }

  async function logout() {
    await store.flushAll();
    if (store.hasUnsaved()) {
      const ok = await confirmDialog('Modifiche non salvate', 'Alcune modifiche non sono ancora state salvate e andranno perse. Uscire comunque?', 'Esci', true);
      if (!ok) return;
    }
    await ctx.signOut();
  }

  function setTheme(theme: 'auto' | 'light' | 'dark') {
    prefs.theme = theme;
    applyTheme(theme);
    persist();
  }

  function toggleMono() {
    prefs.mono = !prefs.mono;
    app.classList.toggle('mono', prefs.mono);
    persist();
    autosize();
  }

  const commands: Command[] = [
    { id: 'new', label: 'Nuova nota', keys: 'mod+alt+n', run: () => void newNote() },
    { id: 'open', label: 'Apri nota…', keys: 'mod+p', run: () => openPalette('files') },
    { id: 'save', label: 'Salva ora', keys: 'mod+s', run: () => void saveNow() },
    { id: 'rename', label: 'Rinomina nota', keys: 'F2', run: focusTitle, when: () => !!activeNote() },
    { id: 'delete', label: 'Elimina nota', keys: 'mod+shift+backspace', run: () => void deleteNote(prefs.active), when: () => !!activeNote() },
    { id: 'close', label: 'Chiudi scheda', keys: 'mod+alt+w', run: () => (rootOpen ? closeRoot() : closeTab(prefs.active)), when: () => rootOpen || !!activeNote() },
    { id: 'root', label: 'Root: richieste di accesso', run: () => openRoot(), when: () => !!ctx.admin },
    { id: 'next', label: 'Scheda successiva', keys: 'ctrl+alt+right', run: () => cycleTab(1) },
    { id: 'prev', label: 'Scheda precedente', keys: 'ctrl+alt+left', run: () => cycleTab(-1) },
    { id: 'find', label: 'Trova nella nota', keys: 'mod+f', run: openFind, when: () => !!activeNote() },
    { id: 'search', label: 'Cerca in tutte le note', keys: 'mod+shift+f', run: () => focusSearch() },
    { id: 'sidebar', label: 'Mostra/nascondi elenco note', keys: 'mod+b', run: toggleSidebar },
    { id: 'checklist', label: 'Checklist on/off', keys: 'mod+shift+l', run: () => withBody(ed.toggleChecklist), when: () => !!activeNote() },
    { id: 'checked', label: 'Segna elemento completato', keys: 'mod+shift+u', run: () => withBody(ed.toggleChecked), when: () => !!activeNote() },
    { id: 'dup', label: 'Duplica riga', keys: 'mod+shift+d', run: () => withBody(ed.duplicateLine), when: () => !!activeNote() },
    { id: 'delline', label: 'Elimina riga', keys: 'mod+shift+k', run: () => withBody(ed.deleteLine), when: () => !!activeNote() },
    { id: 'selline', label: 'Seleziona riga', keys: 'mod+l', run: () => withBody(ed.selectLine), when: () => !!activeNote() },
    { id: 'up', label: 'Sposta riga su', keys: isMac ? 'ctrl+mod+up' : 'ctrl+shift+up', run: () => withBody((t) => ed.moveLines(t, -1)), when: () => !!activeNote() },
    { id: 'down', label: 'Sposta riga giù', keys: isMac ? 'ctrl+mod+down' : 'ctrl+shift+down', run: () => withBody((t) => ed.moveLines(t, 1)), when: () => !!activeNote() },
    { id: 'mono', label: 'Font monospace on/off', run: toggleMono },
    { id: 'theme-auto', label: 'Tema: automatico (sistema)', run: () => setTheme('auto') },
    { id: 'theme-light', label: 'Tema: chiaro', run: () => setTheme('light') },
    { id: 'theme-dark', label: 'Tema: scuro', run: () => setTheme('dark') },
    { id: 'sync', label: 'Sincronizza ora', run: () => void store.reconcile().then(() => toast('Note aggiornate.')) },
    { id: 'logout', label: 'Esci', run: () => void logout() },
  ];

  function focusSearch() {
    if (!prefs.sidebar) toggleSidebar();
    showList();
    searchInput.focus();
    searchInput.select();
  }

  // ------------------------------------------------------------------ palette

  let pMode: 'files' | 'commands' = 'files';
  let pItems: PaletteItem[] = [];
  let pIndex = 0;
  let pReturnFocus: HTMLElement | null = null;

  function openPalette(mode: 'files' | 'commands') {
    if (!palette.hidden && pMode === mode) return closePalette();
    pMode = mode;
    pReturnFocus = document.activeElement as HTMLElement | null;
    palette.hidden = false;
    pInput.value = mode === 'commands' ? '>' : '';
    pInput.placeholder = mode === 'commands' ? 'Esegui un comando…' : 'Vai alla nota… (digita > per i comandi)';
    renderPalette();
    pInput.focus();
    pInput.setSelectionRange(pInput.value.length, pInput.value.length);
  }

  function closePalette(restore = true) {
    palette.hidden = true;
    if (restore) pReturnFocus?.focus();
  }

  function renderPalette() {
    const raw = pInput.value;
    const isCmd = raw.startsWith('>');
    const q = isCmd ? raw.slice(1).trim() : raw.trim();
    const items: Array<PaletteItem & { score: number }> = [];
    if (isCmd) {
      for (const c of commands) {
        if (c.when && !c.when()) continue;
        const m = fuzzy(q, c.label);
        if (m) items.push({ label: c.label, keys: c.keys, indices: m.indices, score: m.score, run: c.run });
      }
    } else {
      for (const n of store.all()) {
        const title = n.title.trim() || 'Senza titolo';
        const m = fuzzy(q, title);
        if (m) items.push({ label: title, detail: firstLine(n.content), indices: m.indices, score: m.score, run: () => openNote(n.id) });
      }
    }
    if (q) items.sort((a, b) => b.score - a.score);
    pItems = items.slice(0, 60);
    pIndex = 0;
    drawPaletteList();
  }

  function drawPaletteList() {
    pList.replaceChildren(
      ...(pItems.length
        ? pItems.map((it, i) =>
            h(
              'div',
              {
                class: `palette-item${i === pIndex ? ' active' : ''}`,
                role: 'option',
                'aria-selected': String(i === pIndex),
                onmousedown: (e: MouseEvent) => {
                  e.preventDefault();
                  runPalette(i);
                },
                onmousemove: () => {
                  if (pIndex !== i) {
                    pIndex = i;
                    drawPaletteList();
                  }
                },
              },
              h('div', { class: 'pi-main' }, h('span', { class: 'pi-label' }, highlight(it.label, it.indices)), it.detail ? h('span', { class: 'pi-detail' }, it.detail) : null),
              it.keys ? h('kbd', null, kbd(it.keys)) : null,
            ),
          )
        : [h('div', { class: 'palette-empty' }, 'Nessun risultato')]),
    );
    pList.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  function runPalette(i: number) {
    const it = pItems[i];
    if (!it) return;
    closePalette(false);
    it.run();
  }

  pInput.addEventListener('input', renderPalette);
  pInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!pItems.length) return;
      pIndex = (pIndex + (e.key === 'ArrowDown' ? 1 : -1) + pItems.length) % pItems.length;
      drawPaletteList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runPalette(pIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closePalette();
    }
  });
  palette.addEventListener('mousedown', (e) => {
    if (e.target === palette) closePalette();
  });

  // ------------------------------------------------------------ dialogs/toast

  function confirmDialog(title: string, message: string, confirmLabel: string, destructive = false): Promise<boolean> {
    return new Promise((resolve) => {
      const cancel = h('button', { type: 'button', class: 'btn', onclick: () => dialog.close('cancel') }, 'Annulla');
      const ok = h('button', { type: 'button', class: `btn ${destructive ? 'danger' : 'primary'}`, onclick: () => dialog.close('ok') }, confirmLabel);
      dialog.replaceChildren(h('h2', null, title), h('p', null, message), h('div', { class: 'dialog-actions' }, cancel, ok));
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
      dialog.returnValue = '';
      dialog.showModal();
      cancel.focus();
    });
  }

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function toast(text: string, kind: 'info' | 'error' = 'info') {
    toastEl.textContent = text;
    toastEl.className = `toast ${kind}`;
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), kind === 'error' ? 6000 : 3000);
  }

  // ---------------------------------------------------------------- shortcuts

  let chordUntil = 0;
  listen(
    window,
    'keydown',
    (e) => {
      if (dialog.open) return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      const code = e.code;
      const now = Date.now();
      const take = (fn: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      };

      if (chordUntil > now && mod && code === 'KeyB') {
        chordUntil = 0;
        return take(toggleSidebar);
      }
      if (mod && !e.shiftKey && !e.altKey && code === 'KeyK') {
        chordUntil = now + 1500;
        return take(() => {});
      }
      if (mod && !e.altKey && code === 'KeyP') return take(() => openPalette(e.shiftKey ? 'commands' : 'files'));
      if (e.key === 'F1') return take(() => openPalette('commands'));
      if (e.key === 'Escape' && !palette.hidden) return take(() => closePalette());
      if (!palette.hidden) return;

      if (mod && !e.altKey && code === 'KeyS') return take(() => void saveNow());
      if (mod && e.altKey && code === 'KeyN') return take(() => void newNote());
      if (mod && e.altKey && code === 'KeyW') return take(() => (rootOpen ? closeRoot() : closeTab(prefs.active)));
      if (e.ctrlKey && e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) return take(() => cycleTab(e.key === 'ArrowRight' ? 1 : -1));
      const tabCombo = isMac ? e.metaKey && e.altKey : e.altKey && !e.ctrlKey;
      if (tabCombo && /^Digit[1-9]$/.test(code)) {
        const id = prefs.tabs[Number(code.slice(5)) - 1];
        if (id) return take(() => openNote(id));
      }
      if (mod && e.shiftKey && code === 'KeyF') return take(focusSearch);
      if (mod && !e.shiftKey && !e.altKey && code === 'KeyF' && activeNote()) return take(openFind);
      if (mod && code === 'KeyG' && activeNote()) return take(() => findStep(e.shiftKey ? -1 : 1));
      if (mod && !e.shiftKey && !e.altKey && code === 'KeyB') return take(toggleSidebar);
      if (e.key === 'F2' && activeNote()) return take(focusTitle);
      if (mod && e.shiftKey && (e.key === 'Backspace' || e.key === 'Delete') && activeNote()) return take(() => void deleteNote(prefs.active));
      if (e.key === 'Escape' && findOpen) return take(() => closeFind(true));
    },
    { capture: true },
  );

  // ---------------------------------------------------------- store & window

  const offStore = store.on((e: StoreEvent) => {
    switch (e.type) {
      case 'list':
        schedule('list', 'tabs');
        break;
      case 'note':
        schedule('status', 'conflict', 'tabs', 'list');
        break;
      case 'remote':
        if (e.id === prefs.active) applyRemoteToEditor();
        schedule('status', 'conflict', 'tabs', 'list');
        break;
      case 'removed': {
        const wasActive = e.id === prefs.active;
        const idx = prefs.tabs.indexOf(e.id);
        if (idx !== -1) prefs.tabs.splice(idx, 1);
        if (wasActive) {
          prefs.active = prefs.tabs[Math.min(Math.max(idx, 0), prefs.tabs.length - 1)] ?? null;
          loadEditor();
        }
        persist();
        schedule('list', 'tabs');
        break;
      }
      case 'connection':
        schedule('connection');
        break;
    }
  });
  cleanups.push(offStore);

  listen(window, 'beforeunload', (e) => {
    if (store.hasUnsaved()) {
      void store.flushAll();
      e.preventDefault();
    }
  });
  listen(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') void store.flushAll();
    else void store.reconcile();
  });
  listen(window, 'online', () => {
    void store.flushAll();
    void store.reconcile();
  });

  // --------------------------------------------------------------------- boot

  app.classList.toggle('sidebar-hidden', !prefs.sidebar);
  app.classList.toggle('mono', prefs.mono);
  if (ctx.admin) {
    adminPanel = createAdminPanel(ctx.admin, {
      toast,
      confirm: confirmDialog,
      onPendingChange: () => schedule('tabs'),
    });
  }
  editorScroll.hidden = true;
  listEl.replaceChildren(h('div', { class: 'list-empty' }, h('div', { class: 'spinner' }), h('p', null, 'Caricamento note…')));
  renderConnection();

  const boot = async () => {
    try {
      await store.load();
      prefs.tabs = prefs.tabs.filter((id) => store.get(id));
      if (!store.get(prefs.active)) prefs.active = prefs.tabs[0] ?? null;
      if (!prefs.active && store.size && !MOBILE.matches) {
        prefs.active = store.all()[0].id;
        prefs.tabs.push(prefs.active);
      }
      persist();
      loadEditor();
      if (MOBILE.matches) app.classList.remove('mobile-editor');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      listEl.replaceChildren(
        h('div', { class: 'list-empty error' }, h('p', null, 'Impossibile caricare le note.'), h('p', { class: 'small' }, msg), h('button', { type: 'button', class: 'btn', onclick: () => void boot() }, 'Riprova')),
      );
    }
  };
  void boot();

  return () => {
    cleanups.forEach((fn) => fn());
    adminPanel?.dispose();
    store.dispose();
    cancelAnimationFrame(frame);
    clearTimeout(toastTimer);
    root.replaceChildren();
  };
}
