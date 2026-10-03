import './styles.css';
import { createClient, type Session } from '@supabase/supabase-js';
import { readConfig } from './config';
import { renderAuth, renderConfigError, renderLoading, renderPasswordRecovery } from './auth-view';
import { mountApp } from './app-view';
import { supabaseBackend } from './backend';
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

  let current: { userId: string; dispose: () => void } | null = null;
  let recovering = false;

  const route = (session: Session | null) => {
    if (recovering) return;
    if (session) {
      if (current?.userId === session.user.id) return;
      current?.dispose();
      const store = new NotesStore(supabaseBackend(sb, session.user.id));
      const dispose = mountApp(root, {
        store,
        userId: session.user.id,
        email: session.user.email ?? '',
        signOut: async () => {
          await sb.auth.signOut();
        },
      });
      current = { userId: session.user.id, dispose };
    } else {
      current?.dispose();
      current = null;
      renderAuth(root, sb, urlError);
    }
  };

  sb.auth.onAuthStateChange((event, session) => {
    // Supabase recommends not awaiting other Supabase calls inside this callback.
    setTimeout(() => {
      if (event === 'PASSWORD_RECOVERY') {
        recovering = true;
        current?.dispose();
        current = null;
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
