// Quaderno: genera per l'amministratore un link monouso (accesso o nuova password)
// da inviare a mano a un utente, senza passare dall'email di Supabase.
// Le password non sono recuperabili: Supabase ne conserva solo l'hash.
import { createClient } from 'npm:@supabase/supabase-js@2';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'Metodo non consentito.' }, 405);

  const url = Deno.env.get('SUPABASE_URL')!;
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // Autenticazione verificata qui (verify_jwt disattivato): token valido + is_admin() nel database.
  const authHeader = req.headers.get('Authorization') ?? '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Accesso richiesto.' }, 401);

  const asCaller = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: caller, error: callerError } = await asCaller.auth.getUser(token);
  if (callerError || !caller.user) return json({ error: 'Sessione non valida: accedi di nuovo.' }, 401);
  const { data: isAdmin, error: adminError } = await asCaller.rpc('is_admin');
  if (adminError) return json({ error: adminError.message }, 500);
  if (isAdmin !== true) return json({ error: 'Solo l’amministratore può generare link di accesso.' }, 403);

  let body: { user_id?: string; type?: string; redirect_to?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'Richiesta non valida.' }, 400);
  }
  const type = body.type === 'recovery' ? 'recovery' : body.type === 'magiclink' ? 'magiclink' : null;
  if (!type || !body.user_id) return json({ error: 'Parametri mancanti.' }, 400);
  if (body.user_id === caller.user.id) return json({ error: 'Non puoi generare un link per te stesso.' }, 400);

  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: target, error: targetError } = await admin.auth.admin.getUserById(body.user_id);
  if (targetError || !target.user?.email) return json({ error: 'Utente non trovato.' }, 404);

  // redirect_to è comunque vincolato dalla lista "Redirect URLs" di Supabase Auth.
  const { data, error } = await admin.auth.admin.generateLink({
    type,
    email: target.user.email,
    options: body.redirect_to ? { redirectTo: body.redirect_to } : undefined,
  });
  if (error || !data.properties?.action_link) return json({ error: error?.message ?? 'Impossibile generare il link.' }, 500);

  return json({ link: data.properties.action_link, email: target.user.email });
});
