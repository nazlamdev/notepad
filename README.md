# Quaderno

Web app di note personali, in stile Apple Notes, con scorciatoie da tastiera ispirate agli editor di testo per programmatori.
Le note sono salvate su **Supabase**: accedi con il tuo account da qualsiasi PC e trovi le stesse note, aggiornate in tempo reale.

- Frontend: Vite + TypeScript (nessun framework), pubblicato su **GitHub Pages** tramite GitHub Actions.
- Backend: Supabase Auth (email + password, magic link, recupero password), Postgres con RLS, Realtime.

---

## Funzionalità

- Registrazione, login, logout, magic link, recupero password.
- Elenco note raggruppato per data (Oggi, Ieri, 7 giorni precedenti…), ricerca nel testo, creazione, rinomina, eliminazione.
- Schede delle note aperte, palette per aprire le note e palette comandi.
- Salvataggio automatico (debounce 800 ms) con indicatore **Salvato / Salvataggio… / Errore** (più **Conflitto**).
- Sincronizzazione in tempo reale tra dispositivi.
- **Gestione dei conflitti**: ogni salvataggio è condizionato al numero di versione letto (`UPDATE … WHERE version = n`).
  Se la nota è stata modificata altrove mentre hai modifiche non salvate, il salvataggio automatico si ferma e compare un avviso con tre scelte:
  *Mantieni la mia versione*, *Usa la versione remota*, *Tienile entrambe* (la tua versione diventa una nuova nota). Puoi anche vedere la versione remota prima di scegliere.
  Lo stesso vale se la nota viene eliminata su un altro dispositivo mentre la stai modificando.
- Tema chiaro/scuro automatico (o forzato dalla palette comandi), font monospace attivabile, layout a pagina singola su schermi piccoli.

### Scorciatoie

`⌘` su Mac, `Ctrl` su Windows/Linux. Alcune combinazioni classiche (⌘N, ⌘W, ⌘T, ⌘1…9) sono riservate dal browser e non si possono usare in una pagina web, quindi ci sono alternative.

| Azione | Scorciatoia |
|---|---|
| Apri nota (ricerca fuzzy) | `⌘P` |
| Palette comandi | `⌘⇧P` oppure `F1` (o digita `>` in `⌘P`) |
| Nuova nota | `⌘⌥N` |
| Salva subito | `⌘S` |
| Rinomina nota | `F2` (o doppio clic nell'elenco) |
| Elimina nota | `⌘⇧⌫` |
| Chiudi scheda | `⌘⌥W` |
| Scheda successiva / precedente | `Ctrl+Alt+→` / `Ctrl+Alt+←` |
| Vai alla scheda n | `⌘⌥1…9` (Mac), `Alt+1…9` (Windows/Linux) |
| Trova nella nota | `⌘F`, poi `Invio` / `⇧Invio`, oppure `⌘G` / `⌘⇧G` |
| Cerca in tutte le note | `⌘⇧F` |
| Mostra/nascondi elenco | `⌘B` oppure `⌘K ⌘B` |
| Indenta / riduci rientro | `Tab` / `⇧Tab`, `⌘]` / `⌘[` |
| Nuova riga sotto / sopra | `⌘Invio` / `⌘⇧Invio` |
| Duplica riga | `⌘⇧D` |
| Elimina riga | `⌘⇧K` |
| Seleziona riga | `⌘L` |
| Sposta riga su/giù | `⌃⌘↑/↓` (Mac), `Ctrl+⇧+↑/↓` |
| Checklist on/off | `⌘⇧L` |
| Segna elemento completato | `⌘⇧U` |

Premendo `Invio` dentro un elenco (`- `, `* `, `1. `, `- [ ] `) l'elenco continua; su un elemento vuoto l'elenco termina.

### Cosa viene salvato nel browser

- **Sessione Supabase** (token di accesso) in `localStorage`, gestita da `@supabase/supabase-js`: serve per restare connessi.
- **Preferenze dell'interfaccia** in `localStorage` (`quaderno.prefs.v1.<user-id>`): id delle schede aperte, nota attiva, elenco visibile, font, tema.
- **Il contenuto e i titoli delle note non vengono mai salvati nel browser.** Le modifiche non ancora salvate vivono solo in memoria: se chiudi la scheda con modifiche in sospeso l'app tenta un salvataggio immediato e il browser chiede conferma prima di uscire.

---

## Struttura

```
.github/workflows/deploy.yml                    build + deploy su GitHub Pages
supabase/migrations/20261003120000_create_notes.sql   tabella, trigger, RLS, Realtime
src/main.ts            bootstrap, routing auth
src/config.ts          lettura e validazione delle variabili VITE_*
src/auth-view.ts       login, registrazione, magic link, recupero password
src/backend.ts         accesso a Supabase (query + Realtime)
src/notes-store.ts     stato delle note, autosave, conflitti
src/app-view.ts        interfaccia: elenco, schede, editor, palette, ricerca
src/editor-commands.ts comandi di editing del testo
src/styles.css         stile
```

---

## 1. Progetto Supabase

Se non ne hai uno: [supabase.com/dashboard](https://supabase.com/dashboard) → **New project**.

Poi in **Project Settings → API Keys** recupera:

- **Project URL**: `https://<project-ref>.supabase.co`
- **Publishable key** (`sb_publishable_…`) oppure la **legacy anon key** (JWT). Sono chiavi pubbliche, protette da RLS.

> ⚠️ Non usare mai nel frontend la **secret key** (`sb_secret_…`) o la **service_role key**: bypassano RLS e darebbero accesso a tutti i dati a chiunque apra la pagina. La build si blocca e l'app rifiuta di partire se ne trova una.

## 2. Applicare la migration

La migration crea la tabella `notes` (con `id`, `user_id`, `title`, `content`, `version`, `created_at`, `updated_at`), i trigger, le policy RLS, i privilegi di colonna e abilita Realtime. È idempotente: rieseguirla non causa errori.

> La colonna `version` in più rispetto ai campi minimi serve al controllo dei conflitti: viene incrementata dal trigger a ogni modifica.

**Opzione A — SQL Editor (più semplice)**

1. Dashboard → **SQL Editor** → **New query**.
2. Incolla tutto il contenuto di `supabase/migrations/20261003120000_create_notes.sql`.
3. **Run**. Deve terminare con "Success. No rows returned".

**Opzione B — Supabase CLI**

```bash
npx supabase login
```

```bash
npx supabase init
```

(Se chiede di sovrascrivere qualcosa rispondi di no: serve solo a creare `supabase/config.toml`; la cartella `migrations` resta invariata.)

```bash
npx supabase link --project-ref <project-ref>
```

```bash
npx supabase db push
```

**Verifica**: Dashboard → **Table Editor** → `notes` deve comparire con l'etichetta *RLS enabled*; in **Database → Publications → supabase_realtime** la tabella `notes` deve risultare attiva. Se non lo è, attivala lì (la migration lo fa in automatico quando la publication esiste).

### 2b. Accesso su approvazione (tab Root)

Applica anche `supabase/migrations/20261004090000_access_approval.sql` (stesso procedimento: SQL Editor → incolla → Run, oppure `npx supabase db push`).

Come funziona:

- Chiunque può registrarsi (o usare il magic link), ma questo crea solo una **richiesta di accesso** in stato *in attesa*.
- Finché la richiesta non è approvata, le policy RLS impediscono a quell'account di leggere o scrivere note: l'utente vede la schermata "Richiesta in attesa di approvazione", che si aggiorna da sola appena viene approvato.
- L'amministratore è definito nel database, nella tabella `public.app_admins` (preimpostata con `nazzareno.lamanna@gmail.com`). Per essere riconosciuto come admin l'account deve avere l'email **confermata**.
- L'admin vede il tab **Root** (con il numero di richieste in attesa) nella barra delle schede, l'icona a scudo in basso nell'elenco note e il comando "Root" nella palette. Da lì può **Approvare**, **Rifiutare** o **Revocare** l'accesso. Revocare non cancella le note: tornano visibili se l'utente viene riapprovato.
- Le decisioni passano dalla funzione `set_access_status()`, che verifica lato database che chi la chiama sia admin; il client non può modificare la tabella `access_requests` direttamente.

Per aggiungere un altro amministratore (SQL Editor):

```sql
insert into public.app_admins (email) values ('altra.email@esempio.it');
```

> Tieni attiva l'opzione **Confirm email** in Supabase Auth: impedisce che qualcuno si registri con l'email dell'amministratore senza possederla.

## 3. Configurare Auth

Dashboard → **Authentication**:

1. **Sign In / Providers → Email**: abilitato (è il default). Scegli se tenere **Confirm email** attivo (consigliato).
2. **URL Configuration**:
   - **Site URL**: `https://<utente-github>.github.io/<nome-repo>/`
   - **Redirect URLs** (aggiungi tutte):
     - `https://<utente-github>.github.io/<nome-repo>/`
     - `https://<utente-github>.github.io/<nome-repo>/**`
     - `http://localhost:5173/`
     - `http://localhost:5173/**`

   Questi URL sono usati da magic link, conferma email e recupero password: l'app passa sempre come `redirectTo` l'indirizzo da cui è aperta (`origin + base path`). Se un URL non è in elenco Supabase reindirizza al Site URL.
3. (Facoltativo) **Emails → Templates**: personalizza i testi di *Confirm signup*, *Magic Link* e *Reset Password*.
4. Il servizio email integrato di Supabase ha limiti di invio molto bassi: per uso reale configura un SMTP in **Authentication → Emails → SMTP Settings**.

## 4. Sviluppo locale

```bash
cp .env.example .env
```

Compila `.env` con URL e publishable/anon key, poi:

```bash
npm install
```

```bash
npm run dev
```

L'app è su `http://localhost:5173/`. Senza `.env` valido mostra una schermata che spiega cosa manca.

## 5. Deploy su GitHub Pages

1. Crea il repository su GitHub e fai push del branch `main`.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. **Settings → Secrets and variables → Actions → Variables → New repository variable**:
   - `VITE_SUPABASE_URL` = `https://<project-ref>.supabase.co`
   - `VITE_SUPABASE_PUBLISHABLE_KEY` = `sb_publishable_…` (oppure `VITE_SUPABASE_ANON_KEY` = la legacy anon key)

   Sono valori pubblici (finiscono nel JavaScript servito), per questo vanno bene come *Variables*. Il workflow accetta anche *Secrets* con gli stessi nomi, se preferisci.
4. Ogni push su `main` esegue `.github/workflows/deploy.yml`; puoi anche lanciarlo a mano da **Actions → Deploy su GitHub Pages → Run workflow**.
5. L'app sarà su `https://<utente-github>.github.io/<nome-repo>/` (il base path viene calcolato automaticamente da `actions/configure-pages`). Assicurati che sia tra i Redirect URLs di Supabase (passo 3).

---

## Sicurezza

- RLS attiva con policy SELECT/INSERT/UPDATE/DELETE limitate a `auth.uid() = user_id`.
- `user_id` è impostato dal trigger con `auth.uid()` all'inserimento e bloccato negli UPDATE; in più i privilegi di colonna permettono agli utenti di scrivere solo `title` e `content` (e `id` in inserimento).
- Il ruolo `anon` non ha alcun privilegio sulla tabella.
- `version`, `created_at`, `updated_at` sono gestiti esclusivamente dai trigger.
- Gli eventi Realtime rispettano RLS; gli eventi DELETE contengono solo l'id della riga.
- Nessuna condivisione pubblica: ogni nota è visibile solo al proprietario.
- Solo gli account approvati dall'amministratore possono accedere alle note (vedi 2b). Le registrazioni restano aperte perché servono a inviare la richiesta.
