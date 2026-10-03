import { defineConfig, loadEnv } from 'vite';

// Fail the build if someone puts a privileged key into a VITE_* variable:
// everything prefixed with VITE_ ends up in the public JavaScript bundle.
function assertNoSecretKeys(env: Record<string, string>) {
  for (const [name, value] of Object.entries(env)) {
    if (!name.startsWith('VITE_') || !value) continue;
    if (value.startsWith('sb_secret_')) {
      throw new Error(`${name} contiene una secret key Supabase (sb_secret_…). Usa la publishable key.`);
    }
    const parts = value.split('.');
    if (parts.length === 3) {
      try {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        if (payload?.role === 'service_role') {
          throw new Error(`${name} contiene una service_role key. Usa la anon/publishable key.`);
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('service_role')) throw e;
      }
    }
  }
}

export default defineConfig(({ mode }) => {
  assertNoSecretKeys({ ...loadEnv(mode, process.cwd(), 'VITE_'), ...process.env } as Record<string, string>);
  return {
    // GitHub Pages serves project sites from /<repo>/; the workflow passes BASE_PATH.
    base: process.env.BASE_PATH || '/',
    build: { target: 'es2022', sourcemap: false },
  };
});
