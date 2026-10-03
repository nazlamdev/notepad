import type { SupabaseClient } from '@supabase/supabase-js';

export interface NoteRow {
  id: string;
  user_id: string;
  title: string;
  content: string;
  version: number;
  created_at: string;
  updated_at: string;
}

export type ConnectionStatus = 'connecting' | 'live' | 'offline';

export interface RealtimeHandlers {
  upsert(row: NoteRow): void;
  remove(id: string): void;
  status(status: ConnectionStatus, reconnected: boolean): void;
}

/** Data access used by the store. Kept as an interface so the store does not depend on Supabase details. */
export interface NotesBackend {
  fetchAll(): Promise<NoteRow[]>;
  fetchOne(id: string): Promise<NoteRow | null>;
  /** Optimistic update: returns null when `version` no longer matches (someone else saved first). */
  update(id: string, version: number, patch: { title: string; content: string }): Promise<NoteRow | null>;
  insert(note: { id?: string; title: string; content: string }): Promise<NoteRow>;
  remove(id: string): Promise<void>;
  subscribe(handlers: RealtimeHandlers): () => void;
}

export class BackendError extends Error {}

function friendly(error: { message: string; code?: string }): BackendError {
  const msg = error.message || '';
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return new BackendError('Connessione assente: riproverò automaticamente.');
  if (error.code === '42P01' || /relation .*notes.* does not exist|Could not find the table/i.test(msg)) {
    return new BackendError('La tabella "notes" non esiste: applica la migration del database (vedi README).');
  }
  if (error.code === '42501' || /permission denied|row-level security/i.test(msg)) {
    return new BackendError('Permesso negato dal database. Verifica la migration e le policy RLS.');
  }
  if (/JWT|token/i.test(msg)) return new BackendError('Sessione scaduta: esci e accedi di nuovo.');
  return new BackendError(msg || 'Errore sconosciuto dal server.');
}

const COLUMNS = 'id,user_id,title,content,version,created_at,updated_at';

export function supabaseBackend(sb: SupabaseClient, userId: string): NotesBackend {
  const table = () => sb.from('notes');
  return {
    async fetchAll() {
      const { data, error } = await table().select(COLUMNS).order('updated_at', { ascending: false });
      if (error) throw friendly(error);
      return (data ?? []) as NoteRow[];
    },
    async fetchOne(id) {
      const { data, error } = await table().select(COLUMNS).eq('id', id).maybeSingle();
      if (error) throw friendly(error);
      return (data as NoteRow | null) ?? null;
    },
    async update(id, version, patch) {
      const { data, error } = await table().update(patch).eq('id', id).eq('version', version).select(COLUMNS).maybeSingle();
      if (error) throw friendly(error);
      return (data as NoteRow | null) ?? null;
    },
    async insert(note) {
      const { data, error } = await table().insert(note).select(COLUMNS).single();
      if (error) throw friendly(error);
      return data as NoteRow;
    },
    async remove(id) {
      const { error } = await table().delete().eq('id', id);
      if (error) throw friendly(error);
    },
    subscribe(handlers) {
      let subscribedOnce = false;
      const channel = sb
        .channel(`notes-${userId}-${crypto.randomUUID()}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notes', filter: `user_id=eq.${userId}` }, (p) =>
          handlers.upsert(p.new as NoteRow),
        )
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'notes', filter: `user_id=eq.${userId}` }, (p) =>
          handlers.upsert(p.new as NoteRow),
        )
        // DELETE events cannot be filtered by column; the payload only carries the primary key.
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'notes' }, (p) => {
          const id = (p.old as { id?: string }).id;
          if (id) handlers.remove(id);
        })
        .subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            handlers.status('live', subscribedOnce);
            subscribedOnce = true;
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
            handlers.status('offline', false);
          }
        });
      return () => {
        void sb.removeChannel(channel);
      };
    },
  };
}
