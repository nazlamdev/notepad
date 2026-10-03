export type ConfigResult =
  | { ok: true; url: string; key: string }
  | { ok: false; problems: string[] };

function jwtRole(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const json = atob(parts[1].replace(/-/g, '+').replace(/_/g, '/'));
    return (JSON.parse(json) as { role?: string }).role ?? null;
  } catch {
    return null;
  }
}

export function readConfig(): ConfigResult {
  const url = import.meta.env.VITE_SUPABASE_URL?.trim() ?? '';
  const key = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY || '').trim();
  const problems: string[] = [];

  if (!url) {
    problems.push('Manca VITE_SUPABASE_URL.');
  } else {
    try {
      const u = new URL(url);
      if (u.protocol !== 'https:' && u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
        problems.push('VITE_SUPABASE_URL deve usare https.');
      }
    } catch {
      problems.push('VITE_SUPABASE_URL non è un URL valido.');
    }
  }

  if (!key) {
    problems.push('Manca VITE_SUPABASE_PUBLISHABLE_KEY (o VITE_SUPABASE_ANON_KEY).');
  } else if (key.startsWith('sb_secret_') || jwtRole(key) === 'service_role') {
    // Refuse to run with a privileged key: it would bypass RLS for anyone who opens the page.
    problems.push('La chiave configurata è una secret/service_role key: non deve mai stare nel browser. Usa la publishable key e ruota subito quella segreta.');
  }

  return problems.length ? { ok: false, problems } : { ok: true, url, key };
}

/** URL a cui Supabase reindirizza dopo magic link, conferma email e recupero password. */
export function appRedirectUrl(): string {
  return new URL(import.meta.env.BASE_URL, window.location.origin).toString();
}
