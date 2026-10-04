import type { AuthError, SupabaseClient } from '@supabase/supabase-js';
import { appRedirectUrl } from './config';
import { h, icon } from './dom';

type Mode = 'signin' | 'signup' | 'magic' | 'reset';

function brand(): HTMLElement {
  return h(
    'div',
    { class: 'brand' },
    h('div', { class: 'brand-mark', 'aria-hidden': 'true' }),
    h('h1', null, 'Quaderno'),
    h('p', { class: 'muted' }, 'Le tue note, su ogni dispositivo.'),
  );
}

export function authErrorMessage(error: AuthError | Error | { message: string }): string {
  const m = error.message || '';
  if (/Invalid login credentials/i.test(m)) return 'Email o password non corretti.';
  if (/Email not confirmed/i.test(m)) return 'Devi prima confermare l’indirizzo email: controlla la posta.';
  if (/User already registered/i.test(m)) return 'Esiste già un account con questa email. Accedi o recupera la password.';
  if (/Password should be at least/i.test(m)) return 'La password è troppo corta (minimo 6 caratteri, o quanto richiesto dal progetto).';
  if (/rate limit|too many/i.test(m)) return 'Troppe richieste: attendi qualche minuto e riprova.';
  if (/Signups not allowed/i.test(m)) return 'Le registrazioni sono disabilitate in questo progetto Supabase.';
  if (/Failed to fetch|NetworkError|Load failed/i.test(m)) return 'Impossibile contattare il server. Controlla la connessione.';
  if (/Invalid API key|No API key/i.test(m)) return 'Chiave Supabase non valida: verifica VITE_SUPABASE_PUBLISHABLE_KEY.';
  if (/expired|invalid/i.test(m) && /link|otp|token/i.test(m)) return 'Il link è scaduto o non è valido. Richiedine uno nuovo.';
  return m || 'Si è verificato un errore.';
}

export function renderConfigError(root: HTMLElement, problems: string[]): void {
  root.replaceChildren(
    h(
      'main',
      { class: 'auth-screen' },
      h(
        'div',
        { class: 'auth-card wide' },
        brand(),
        h('h2', null, 'Configurazione mancante'),
        h('p', null, 'L’app non è collegata a un progetto Supabase:'),
        h('ul', { class: 'problems' }, ...problems.map((p) => h('li', null, p))),
        h(
          'p',
          { class: 'muted small' },
          'In locale crea il file .env partendo da .env.example. Su GitHub Pages imposta le variabili del repository VITE_SUPABASE_URL e VITE_SUPABASE_PUBLISHABLE_KEY e rilancia il workflow. Dettagli nel README.',
        ),
      ),
    ),
  );
}

export function renderLoading(root: HTMLElement, text = 'Caricamento…'): void {
  root.replaceChildren(h('main', { class: 'auth-screen' }, h('div', { class: 'loading' }, h('div', { class: 'spinner' }), text)));
}

export function renderAuth(root: HTMLElement, sb: SupabaseClient, initialError: string | null): void {
  let mode: Mode = 'signin';
  let busy = false;

  const card = h('div', { class: 'auth-card' });
  root.replaceChildren(h('main', { class: 'auth-screen' }, card));

  const draw = (notice?: { kind: 'error' | 'ok'; text: string }) => {
    const email = h('input', { type: 'email', name: 'email', autocomplete: 'email', required: true, placeholder: 'nome@esempio.it' });
    const password = h('input', {
      type: 'password',
      name: 'password',
      autocomplete: mode === 'signup' ? 'new-password' : 'current-password',
      required: true,
      minLength: 6,
      placeholder: 'Password',
    });
    const needsPassword = mode === 'signin' || mode === 'signup';
    const submitLabel = { signin: 'Accedi', signup: 'Invia richiesta', magic: 'Inviami il link', reset: 'Invia email di recupero' }[mode];
    const submit = h('button', { type: 'submit', class: 'btn primary block' }, submitLabel);

    const form = h(
      'form',
      { class: 'auth-form', novalidate: false },
      h('label', null, h('span', null, 'Email'), email),
      needsPassword && h('label', null, h('span', null, 'Password'), password),
      notice && h('div', { class: `notice ${notice.kind}`, role: notice.kind === 'error' ? 'alert' : 'status' }, notice.text),
      submit,
    );

    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      if (busy) return;
      busy = true;
      submit.disabled = true;
      submit.textContent = 'Attendi…';
      const redirect = appRedirectUrl();
      try {
        const addr = email.value.trim();
        if (mode === 'signin') {
          const { error } = await sb.auth.signInWithPassword({ email: addr, password: password.value });
          if (error) throw error;
          return; // onAuthStateChange takes over
        }
        if (mode === 'signup') {
          const { data, error } = await sb.auth.signUp({ email: addr, password: password.value, options: { emailRedirectTo: redirect } });
          if (error) throw error;
          if (!data.session) draw({ kind: 'ok', text: `Ti abbiamo inviato un’email a ${addr}: apri il link per confermarla. Poi l’amministratore dovrà approvare la richiesta.` });
          return;
        }
        if (mode === 'magic') {
          const { error } = await sb.auth.signInWithOtp({ email: addr, options: { emailRedirectTo: redirect, shouldCreateUser: true } });
          if (error) throw error;
          draw({ kind: 'ok', text: `Link di accesso inviato a ${addr}. Aprilo da questo o da un altro dispositivo.` });
          return;
        }
        const { error } = await sb.auth.resetPasswordForEmail(addr, { redirectTo: redirect });
        if (error) throw error;
        draw({ kind: 'ok', text: `Se esiste un account per ${addr}, riceverai un’email con il link per reimpostare la password.` });
      } catch (e) {
        draw({ kind: 'error', text: authErrorMessage(e as AuthError) });
      } finally {
        busy = false;
        submit.disabled = false;
        submit.textContent = submitLabel;
      }
    });

    const seg = (m: Mode, label: string) =>
      h('button', { type: 'button', class: `seg${mode === m ? ' active' : ''}`, 'aria-pressed': String(mode === m), onclick: () => switchTo(m) }, label);

    const titles: Record<Mode, string> = {
      signin: 'Accedi',
      signup: 'Richiedi un account',
      magic: 'Accedi con un link via email',
      reset: 'Recupera la password',
    };

    card.replaceChildren(
      brand(),
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'Metodo di accesso' }, seg('signin', 'Password'), seg('magic', 'Link email'), seg('signup', 'Richiedi accesso')),
      h('h2', null, titles[mode]),
      ...(mode === 'signup' ? [h('p', { class: 'muted small auth-hint' }, 'Quaderno è su invito: dopo la registrazione la richiesta deve essere approvata dall’amministratore prima di poter usare le note.')] : []),
      form,
      h(
        'div',
        { class: 'auth-links' },
        mode === 'signin' && h('button', { type: 'button', class: 'link', onclick: () => switchTo('reset') }, 'Password dimenticata?'),
        mode === 'reset' && h('button', { type: 'button', class: 'link', onclick: () => switchTo('signin') }, 'Torna all’accesso'),
      ),
    );
    (email as HTMLInputElement).focus();
  };

  const switchTo = (m: Mode) => {
    mode = m;
    draw();
  };

  draw(initialError ? { kind: 'error', text: initialError } : undefined);
}

export function renderPasswordRecovery(root: HTMLElement, sb: SupabaseClient, done: () => void): void {
  const pw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minLength: 6, placeholder: 'Nuova password' });
  const pw2 = h('input', { type: 'password', autocomplete: 'new-password', required: true, minLength: 6, placeholder: 'Ripeti la password' });
  const msg = h('div', { class: 'notice error', role: 'alert', hidden: true });
  const submit = h('button', { type: 'submit', class: 'btn primary block' }, 'Salva nuova password');
  const form = h('form', { class: 'auth-form' }, h('label', null, h('span', null, 'Nuova password'), pw), h('label', null, h('span', null, 'Conferma'), pw2), msg, submit);

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    msg.hidden = true;
    if (pw.value !== pw2.value) {
      msg.textContent = 'Le due password non coincidono.';
      msg.hidden = false;
      return;
    }
    submit.disabled = true;
    const { error } = await sb.auth.updateUser({ password: pw.value });
    submit.disabled = false;
    if (error) {
      msg.textContent = authErrorMessage(error);
      msg.hidden = false;
      return;
    }
    done();
  });

  root.replaceChildren(
    h('main', { class: 'auth-screen' }, h('div', { class: 'auth-card' }, brand(), h('h2', null, 'Imposta una nuova password'), form)),
  );
  pw.focus();
}

export function renderAccessGate(
  root: HTMLElement,
  opts: { status: 'pending' | 'rejected' | 'error'; email: string; message?: string; onRetry: () => void; onSignOut: () => void },
): void {
  const content = {
    pending: {
      title: 'Richiesta in attesa di approvazione',
      text: `Il tuo account (${opts.email}) è stato creato. L’amministratore deve approvarlo prima che tu possa usare Quaderno. Questa pagina si aggiornerà da sola appena la richiesta viene approvata.`,
    },
    rejected: {
      title: 'Accesso non autorizzato',
      text: `L’account ${opts.email} non è stato autorizzato a usare Quaderno. Se pensi sia un errore, contatta l’amministratore.`,
    },
    error: { title: 'Impossibile verificare l’accesso', text: opts.message ?? 'Si è verificato un errore.' },
  }[opts.status];

  root.replaceChildren(
    h(
      'main',
      { class: 'auth-screen' },
      h(
        'div',
        { class: `auth-card gate ${opts.status}` },
        brand(),
        h('div', { class: 'gate-icon', 'aria-hidden': 'true' }, opts.status === 'pending' ? icon('clock') : icon('warning')),
        h('h2', null, content.title),
        h('p', { class: 'muted' }, content.text),
        h(
          'div',
          { class: 'gate-actions' },
          opts.status !== 'rejected' && h('button', { type: 'button', class: 'btn primary', onclick: opts.onRetry }, opts.status === 'pending' ? 'Controlla di nuovo' : 'Riprova'),
          h('button', { type: 'button', class: 'btn', onclick: opts.onSignOut }, 'Esci'),
        ),
      ),
    ),
  );
}
