import type { AccessRequest, AccessStatus, AdminApi } from './access';
import { h, icon } from './dom';
import { longDate } from './format';

export interface AdminPanel {
  el: HTMLElement;
  pending: number;
  refresh(): Promise<void>;
  dispose(): void;
}

interface Helpers {
  toast(text: string, kind?: 'info' | 'error'): void;
  confirm(title: string, message: string, confirmLabel: string, destructive?: boolean): Promise<boolean>;
  onPendingChange(count: number): void;
}

const FILTERS: Array<{ id: AccessStatus; label: string }> = [
  { id: 'pending', label: 'In attesa' },
  { id: 'approved', label: 'Approvati' },
  { id: 'rejected', label: 'Rifiutati' },
];

export function createAdminPanel(api: AdminApi, helpers: Helpers): AdminPanel {
  let rows: AccessRequest[] = [];
  let filter: AccessStatus = 'pending';
  let loaded = false;
  let error: string | null = null;
  const busy = new Set<string>();

  const segWrap = h('div', { class: 'segmented admin-seg', role: 'group', 'aria-label': 'Filtra richieste' });
  const listEl = h('div', { class: 'admin-list' });
  const el = h(
    'section',
    { class: 'admin', 'aria-label': 'Root' },
    h(
      'div',
      { class: 'admin-inner' },
      h('div', { class: 'admin-head' }, h('div', { class: 'admin-badge', 'aria-hidden': 'true' }, icon('shield')), h('div', null, h('h1', null, 'Root'), h('p', { class: 'muted' }, 'Decidi chi può usare Quaderno. Gli account non approvati non possono leggere né salvare note.'))),
      segWrap,
      listEl,
    ),
  );

  const panel: AdminPanel = { el, pending: 0, refresh, dispose };

  function count(s: AccessStatus) {
    return rows.filter((r) => r.status === s && r.user_id !== api.selfId).length;
  }

  function render() {
    panel.pending = count('pending');
    segWrap.replaceChildren(
      ...FILTERS.map((f) => {
        const n = count(f.id);
        return h(
          'button',
          {
            type: 'button',
            class: `seg${filter === f.id ? ' active' : ''}`,
            'aria-pressed': String(filter === f.id),
            onclick: () => {
              filter = f.id;
              render();
            },
          },
          f.label,
          n ? h('span', { class: `seg-count${f.id === 'pending' ? ' hot' : ''}` }, String(n)) : null,
        );
      }),
    );

    if (!loaded) {
      listEl.replaceChildren(h('div', { class: 'list-empty' }, h('div', { class: 'spinner' }), h('p', null, 'Caricamento richieste…')));
      return;
    }
    if (error) {
      listEl.replaceChildren(h('div', { class: 'list-empty error' }, h('p', null, error), h('button', { type: 'button', class: 'btn', onclick: () => void refresh() }, 'Riprova')));
      return;
    }
    const visible = rows.filter((r) => r.status === filter && r.user_id !== api.selfId);
    if (!visible.length) {
      const empty = { pending: 'Nessuna richiesta in attesa.', approved: 'Nessun utente approvato oltre a te.', rejected: 'Nessuna richiesta rifiutata.' }[filter];
      listEl.replaceChildren(h('div', { class: 'list-empty' }, h('p', null, empty)));
      return;
    }
    listEl.replaceChildren(...visible.map(card));
  }

  function card(r: AccessRequest): HTMLElement {
    const isBusy = busy.has(r.user_id);
    const act = (label: string, status: AccessStatus, cls: string, confirmText?: string) =>
      h(
        'button',
        {
          type: 'button',
          class: `btn ${cls}`,
          disabled: isBusy,
          onclick: async () => {
            if (confirmText && !(await helpers.confirm(label, confirmText, label, status !== 'approved'))) return;
            busy.add(r.user_id);
            render();
            try {
              await api.setStatus(r.user_id, status);
              r.status = status;
              r.decided_at = new Date().toISOString();
              helpers.toast(status === 'approved' ? `${r.email} può ora accedere.` : status === 'rejected' ? `Accesso negato a ${r.email}.` : 'Aggiornato.');
            } catch (e) {
              helpers.toast(e instanceof Error ? e.message : String(e), 'error');
            } finally {
              busy.delete(r.user_id);
              render();
              helpers.onPendingChange(panel.pending);
            }
          },
        },
        label,
      );

    const actions =
      r.status === 'pending'
        ? [act('Rifiuta', 'rejected', ''), act('Approva', 'approved', 'primary')]
        : r.status === 'approved'
          ? [act('Revoca accesso', 'rejected', 'danger-outline', `${r.email} non potrà più vedere né modificare le sue note finché non lo approvi di nuovo. Le note non vengono cancellate.`)]
          : [act('Approva', 'approved', 'primary')];

    const when =
      r.status === 'pending' ? `Richiesta il ${longDate(Date.parse(r.created_at))}` : `${r.status === 'approved' ? 'Approvato' : 'Rifiutato'} il ${longDate(Date.parse(r.decided_at ?? r.created_at))}`;

    return h(
      'div',
      { class: `admin-card ${r.status}` },
      h('div', { class: 'avatar', 'aria-hidden': 'true' }, (r.email[0] ?? '?').toUpperCase()),
      h('div', { class: 'admin-card-main' }, h('div', { class: 'admin-email' }, r.email || '(senza email)'), h('div', { class: 'muted small' }, when)),
      h('div', { class: 'admin-actions' }, ...actions),
    );
  }

  async function refresh() {
    try {
      rows = await api.list();
      error = null;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    loaded = true;
    render();
    helpers.onPendingChange(panel.pending);
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  const unsubscribe = api.subscribe((row, event) => {
    if (event === 'INSERT' && row && row.status === 'pending') helpers.toast(`Nuova richiesta di accesso da ${row.email}.`);
    clearTimeout(timer);
    timer = setTimeout(() => void refresh(), 250);
  });

  function dispose() {
    clearTimeout(timer);
    unsubscribe();
  }

  render();
  void refresh();
  return panel;
}
