import type { ConnectionStatus, NoteRow, NotesBackend } from './backend';

export const SAVE_DEBOUNCE_MS = 800;

export type Conflict = { kind: 'updated'; row: NoteRow } | { kind: 'deleted' };

export interface Note {
  id: string;
  /** Local (editor) values. */
  title: string;
  content: string;
  /** Last row confirmed by the server: the base our next save is checked against. */
  server: NoteRow;
  dirty: boolean;
  saving: boolean;
  error: string | null;
  conflict: Conflict | null;
  /** Local edit time, so the note jumps to the top of the list while typing. */
  touchedAt: number;
}

export type SaveState = 'saved' | 'saving' | 'error' | 'conflict';

export type StoreEvent =
  | { type: 'list' }
  | { type: 'note'; id: string }
  | { type: 'remote'; id: string }
  | { type: 'removed'; id: string }
  | { type: 'connection'; status: ConnectionStatus };

interface Internal {
  timer?: ReturnType<typeof setTimeout>;
  retries: number;
  /** Realtime row received while a save was in flight (may be our own echo). */
  pendingRemote: NoteRow | null;
}

export class NotesStore {
  private notes = new Map<string, Note>();
  private internal = new Map<string, Internal>();
  private listeners = new Set<(e: StoreEvent) => void>();
  private unsubscribe: (() => void) | null = null;
  private reconciling = false;
  connection: ConnectionStatus = 'connecting';

  constructor(private backend: NotesBackend) {}

  on(fn: (e: StoreEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(e: StoreEvent) {
    for (const fn of this.listeners) fn(e);
  }

  get(id: string | null | undefined): Note | undefined {
    return id ? this.notes.get(id) : undefined;
  }

  all(): Note[] {
    return [...this.notes.values()].sort((a, b) => sortKey(b) - sortKey(a));
  }

  get size(): number {
    return this.notes.size;
  }

  state(n: Note): SaveState {
    if (n.conflict) return 'conflict';
    if (n.error) return 'error';
    if (n.saving || n.dirty) return 'saving';
    return 'saved';
  }

  hasUnsaved(): boolean {
    for (const n of this.notes.values()) if (n.dirty || n.saving) return true;
    return false;
  }

  // ---------------------------------------------------------------- lifecycle

  async load(): Promise<void> {
    const rows = await this.backend.fetchAll();
    for (const row of rows) this.notes.set(row.id, fromRow(row));
    this.emit({ type: 'list' });
    this.unsubscribe = this.backend.subscribe({
      upsert: (row) => this.applyRemote(row),
      remove: (id) => this.applyRemoteDelete(id),
      status: (status, reconnected) => {
        this.connection = status;
        this.emit({ type: 'connection', status });
        // Events may have been missed while disconnected: re-read everything.
        if (status === 'live' && reconnected) void this.reconcile();
      },
    });
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const i of this.internal.values()) clearTimeout(i.timer);
    this.listeners.clear();
  }

  /** Re-fetch every note and merge it through the same conflict-aware path as Realtime events. */
  async reconcile(): Promise<void> {
    if (this.reconciling) return;
    this.reconciling = true;
    try {
      const rows = await this.backend.fetchAll();
      const seen = new Set(rows.map((r) => r.id));
      for (const row of rows) this.applyRemote(row);
      for (const id of [...this.notes.keys()]) if (!seen.has(id)) this.applyRemoteDelete(id);
    } catch {
      /* stay with what we have; next reconnect will retry */
    } finally {
      this.reconciling = false;
    }
  }

  // ------------------------------------------------------------------ editing

  edit(id: string, patch: { title?: string; content?: string }): void {
    const n = this.notes.get(id);
    if (!n) return;
    if (patch.title !== undefined) n.title = patch.title;
    if (patch.content !== undefined) n.content = patch.content;
    n.dirty = n.title !== n.server.title || n.content !== n.server.content;
    n.touchedAt = Date.now();
    n.error = null;
    if (n.dirty) this.scheduleSave(id, SAVE_DEBOUNCE_MS);
    else clearTimeout(this.int(id).timer);
    this.emit({ type: 'note', id });
    this.emit({ type: 'list' });
  }

  rename(id: string, title: string): void {
    this.edit(id, { title });
    void this.save(id);
  }

  /** Save every dirty note now (Cmd+S, tab hidden, logout). */
  async flushAll(): Promise<void> {
    await Promise.all([...this.notes.values()].filter((n) => n.dirty).map((n) => this.save(n.id)));
  }

  private int(id: string): Internal {
    let i = this.internal.get(id);
    if (!i) this.internal.set(id, (i = { retries: 0, pendingRemote: null }));
    return i;
  }

  private scheduleSave(id: string, ms: number) {
    const i = this.int(id);
    clearTimeout(i.timer);
    i.timer = setTimeout(() => void this.save(id), ms);
  }

  async save(id: string): Promise<void> {
    const n = this.notes.get(id);
    if (!n || !n.dirty || n.saving || n.conflict) return;
    const i = this.int(id);
    clearTimeout(i.timer);
    n.saving = true;
    n.error = null;
    this.emit({ type: 'note', id });

    const sent = { title: n.title, content: n.content };
    try {
      const row = await this.backend.update(id, n.server.version, sent);
      n.saving = false;
      if (!this.notes.has(id)) return;
      i.retries = 0;
      if (!row) {
        // Version mismatch: another device saved (or deleted) first. Never overwrite blindly.
        await this.detectConflict(n);
      } else {
        n.server = row;
        n.dirty = n.title !== row.title || n.content !== row.content;
        if (n.dirty) this.scheduleSave(id, 300);
        const pending = i.pendingRemote;
        i.pendingRemote = null;
        if (pending && pending.version > row.version) this.applyRemote(pending);
      }
    } catch (e) {
      n.saving = false;
      n.error = e instanceof Error ? e.message : String(e);
      i.retries++;
      this.scheduleSave(id, Math.min(30_000, 1000 * 2 ** i.retries));
    }
    this.emit({ type: 'note', id });
    this.emit({ type: 'list' });
  }

  private async detectConflict(n: Note) {
    try {
      const latest = await this.backend.fetchOne(n.id);
      if (!latest) n.conflict = { kind: 'deleted' };
      else if (latest.title === n.title && latest.content === n.content) {
        n.server = latest;
        n.dirty = false;
      } else n.conflict = { kind: 'updated', row: latest };
    } catch (e) {
      n.error = e instanceof Error ? e.message : String(e);
      this.scheduleSave(n.id, 5000);
    }
  }

  // ------------------------------------------------------------ remote changes

  private applyRemote(row: NoteRow) {
    const n = this.notes.get(row.id);
    if (!n) {
      this.notes.set(row.id, fromRow(row));
      this.emit({ type: 'list' });
      return;
    }
    if (row.version <= n.server.version) return; // our own echo or stale
    const i = this.int(row.id);
    if (n.saving) {
      if (!i.pendingRemote || row.version > i.pendingRemote.version) i.pendingRemote = row;
      return;
    }
    if (!n.dirty) {
      n.server = row;
      n.title = row.title;
      n.content = row.content;
      n.conflict = null;
      this.emit({ type: 'remote', id: row.id });
      this.emit({ type: 'list' });
      return;
    }
    if (row.title === n.title && row.content === n.content) {
      n.server = row;
      n.dirty = false;
      n.conflict = null;
      clearTimeout(i.timer);
    } else {
      // Local unsaved edits + newer remote version: stop autosave and let the user decide.
      n.conflict = { kind: 'updated', row };
      clearTimeout(i.timer);
    }
    this.emit({ type: 'note', id: row.id });
  }

  private applyRemoteDelete(id: string) {
    const n = this.notes.get(id);
    if (!n) return;
    if (n.dirty || n.saving) {
      n.conflict = { kind: 'deleted' };
      clearTimeout(this.int(id).timer);
      this.emit({ type: 'note', id });
      return;
    }
    this.forget(id);
  }

  private forget(id: string) {
    clearTimeout(this.internal.get(id)?.timer);
    this.internal.delete(id);
    this.notes.delete(id);
    this.emit({ type: 'removed', id });
    this.emit({ type: 'list' });
  }

  // -------------------------------------------------------- conflict resolution

  /** Keep the local text and overwrite (or re-create) the server version. */
  async keepLocal(id: string): Promise<void> {
    const n = this.notes.get(id);
    if (!n?.conflict) return;
    if (n.conflict.kind === 'updated') {
      n.server = n.conflict.row;
      n.conflict = null;
      n.dirty = true;
      await this.save(id);
      return;
    }
    const row = await this.backend.insert({ id, title: n.title, content: n.content });
    n.server = row;
    n.conflict = null;
    n.dirty = n.title !== row.title || n.content !== row.content;
    n.error = null;
    this.emit({ type: 'note', id });
    this.emit({ type: 'list' });
  }

  /** Discard local edits and adopt the server state. */
  keepRemote(id: string): void {
    const n = this.notes.get(id);
    if (!n?.conflict) return;
    if (n.conflict.kind === 'deleted') {
      this.forget(id);
      return;
    }
    const row = n.conflict.row;
    n.server = row;
    n.title = row.title;
    n.content = row.content;
    n.dirty = false;
    n.conflict = null;
    n.error = null;
    this.emit({ type: 'remote', id });
    this.emit({ type: 'note', id });
    this.emit({ type: 'list' });
  }

  /** Save the local text as a new note, then adopt the server state for this one. */
  async keepBoth(id: string): Promise<string | null> {
    const n = this.notes.get(id);
    if (!n?.conflict) return null;
    const copy = await this.create(`${n.title} (copia locale)`, n.content);
    this.keepRemote(id);
    return copy;
  }

  // -------------------------------------------------------------- create/delete

  async create(title = 'Nuova nota', content = ''): Promise<string> {
    const row = await this.backend.insert({ title, content });
    if (!this.notes.has(row.id)) this.notes.set(row.id, fromRow(row));
    this.emit({ type: 'list' });
    return row.id;
  }

  async remove(id: string): Promise<void> {
    const n = this.notes.get(id);
    if (!n) return;
    clearTimeout(this.int(id).timer);
    if (n.conflict?.kind !== 'deleted') await this.backend.remove(id);
    this.forget(id);
  }
}

function fromRow(row: NoteRow): Note {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    server: row,
    dirty: false,
    saving: false,
    error: null,
    conflict: null,
    touchedAt: 0,
  };
}

function sortKey(n: Note): number {
  return Math.max(Date.parse(n.server.updated_at) || 0, n.touchedAt);
}
