import './styles.css';
import { createClient, type Session } from '@supabase/supabase-js';
import { readConfig } from './config';
import { renderAccessGate, renderAuth, renderConfigError, renderLoading, renderPasswordRecovery } from './auth-view';
import { mountApp } from './app-view';
import { supabaseBackend } from './backend';
import { fetchAccess, supabaseAdminApi, watchOwnAccess } from './access';
import { NotesStore } from './notes-store';

const root = document.getElementById('app')!;

/** Errors returned by Supabase in the redirect URL (expired magic link, etc.). */
function takeUrlError(): string | null {
  const params = new URLSearchParams(window.location.hash.slice(1) || window.location.search.slice(1));
  const desc = params.get('error_description') || params.get('error');
  if (!desc) return null;
  history.replaceState(null, '', window.location.pathname);
  if (/expired|invalid/i.test(desc)) return 'Il link è scaduto o non è più valido. Richiedine uno nuovo.';
  return desc.replace(/\+/g, ' ');
}

function start() {
  const cfg = readConfig();
  if (!cfg.ok) {
    renderConfigError(root, cfg.problems);
    return;
  }

  const urlError = takeUrlError();
  renderLoading(root);

  const sb = createClient(cfg.url, cfg.key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  type View = 'app' | 'pending' | 'rejected' | 'error';
  let mounted: { userId: string; view: View; dispose: () => void } | null = null;
  let watcher: { userId: string; stop: () => void } | null = null;
  let recovering = false;
  let routeSeq = 0;

  const teardown = () => {
    mounted?.dispose();
    mounted = null;
    watcher?.stop();
    watcher = null;
  };

  const signOut = async () => {
    await sb.auth.signOut();
  };

  /** Mount the right screen for a signed-in user, based on their approval status. */
  const enter = async (session: Session, force = false) => {
    const userId = session.user.id;
    const email = session.user.email ?? '';
    if (!force && mounted?.userId === userId) return;
    const seq = ++routeSeq;

    if (watcher?.userId !== userId) {
      teardown();
      // Re-check when the admin approves, rejects or revokes this account.
      watcher = { userId, stop: watchOwnAccess(sb, userId, () => void enter(session, true)) };
    }
    if (!mounted) renderLoading(root, 'Verifica dell’accesso…');

    const gate = (status: 'pending' | 'rejected' | 'error', message?: string) => {
      mounted?.dispose();
      renderAccessGate(root, { status, email, message, onRetry: () => void enter(session, true), onSignOut: () => void signOut() });
      mounted = { userId, view: status, dispose: () => {} };
    };

    try {
      const access = await fetchAccess(sb, userId);
      if (seq !== routeSeq) return;
      if (access.status !== 'approved') return gate(access.status);
      if (mounted?.view === 'app') return; // still approved: keep the running app
      mounted?.dispose();
      const store = new NotesStore(supabaseBackend(sb, userId));
      const dispose = mountApp(root, {
        store,
        userId,
        email,
        signOut,
        admin: access.isAdmin ? supabaseAdminApi(sb, userId) : undefined,
      });
      mounted = { userId, view: 'app', dispose };
    } catch (e) {
      if (seq !== routeSeq) return;
      if (mounted?.view === 'app') return; // transient error during a re-check: keep the app
      gate('error', e instanceof Error ? e.message : String(e));
    }
  };

  const route = (session: Session | null) => {
    if (recovering) return;
    if (session) void enter(session);
    else {
      routeSeq++;
      teardown();
      renderAuth(root, sb, urlError);
    }
  };

  sb.auth.onAuthStateChange((event, session) => {
    // Supabase recommends not awaiting other Supabase calls inside this callback.
    setTimeout(() => {
      if (event === 'PASSWORD_RECOVERY') {
        recovering = true;
        routeSeq++;
        teardown();
        renderPasswordRecovery(root, sb, () => {
          recovering = false;
          history.replaceState(null, '', window.location.pathname);
          void sb.auth.getSession().then(({ data }) => route(data.session));
        });
        return;
      }
      if (event === 'SIGNED_IN' && window.location.hash.includes('access_token')) {
        history.replaceState(null, '', window.location.pathname);
      }
      route(session);
    }, 0);
  });
}

start();
