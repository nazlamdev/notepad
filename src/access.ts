import type { SupabaseClient } from '@supabase/supabase-js';

export type AccessStatus = 'pending' | 'approved' | 'rejected';

export interface AccessRequest {
  user_id: string;
  email: string;
  status: AccessStatus;
  created_at: string;
  decided_at: string | null;
}

export interface AccessInfo {
  status: AccessStatus;
  isAdmin: boolean;
}

/** Admin operations used by the Root panel. Authorization is enforced in the database. */
export interface AdminApi {
  selfId: string;
  list(): Promise<AccessRequest[]>;
  setStatus(userId: string, status: AccessStatus): Promise<void>;
  subscribe(onChange: (row: AccessRequest | null, event: string) => void): () => void;
}

function friendly(error: { message: string; code?: string }): Error {
  const msg = error.message || '';
  if (error.code === 'PGRST202' || /Could not find the function/i.test(msg) || error.code === 'PGRST205') {
    return new Error('Manca la migration "access_approval" nel database: applicala dal SQL Editor (vedi README).');
  }
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) return new Error('Impossibile contattare il server. Controlla la connessione.');
  return new Error(msg || 'Errore sconosciuto.');
}

const COLUMNS = 'user_id,email,status,created_at,decided_at';

export async function fetchAccess(sb: SupabaseClient, userId: string): Promise<AccessInfo> {
  const [admin, own] = await Promise.all([
    sb.rpc('is_admin'),
    sb.from('access_requests').select('status').eq('user_id', userId).maybeSingle(),
  ]);
  if (admin.error) throw friendly(admin.error);
  if (own.error) throw friendly(own.error);
  const isAdmin = admin.data === true;
  const status = isAdmin ? 'approved' : ((own.data?.status as AccessStatus | undefined) ?? 'pending');
  return { status, isAdmin };
}

/** Notifies when the current user's own request changes (approved, rejected, revoked). */
export function watchOwnAccess(sb: SupabaseClient, userId: string, onChange: () => void): () => void {
  const channel = sb
    .channel(`access-self-${userId}-${crypto.randomUUID()}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'access_requests', filter: `user_id=eq.${userId}` }, () => onChange())
    .subscribe();
  return () => {
    void sb.removeChannel(channel);
  };
}

export function supabaseAdminApi(sb: SupabaseClient, selfId: string): AdminApi {
  return {
    selfId,
    async list() {
      const { data, error } = await sb.from('access_requests').select(COLUMNS).order('created_at', { ascending: false });
      if (error) throw friendly(error);
      return (data ?? []) as AccessRequest[];
    },
    async setStatus(userId, status) {
      const { error } = await sb.rpc('set_access_status', { target: userId, new_status: status });
      if (error) throw friendly(error);
    },
    subscribe(onChange) {
      const channel = sb
        .channel(`access-admin-${crypto.randomUUID()}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'access_requests' }, (p) =>
          onChange(p.eventType === 'DELETE' ? null : (p.new as AccessRequest), p.eventType),
        )
        .subscribe();
      return () => {
        void sb.removeChannel(channel);
      };
    },
  };
}
