import { env } from '$env/dynamic/public';

/**
 * Runtime configuration.
 *
 * The URL comes from the committed `.env.development` (non-sensitive, see
 * CLAUDE.md). The publishable key does NOT: `bin/dev-run-web.sh` reads it out of
 * `supabase status` and exports PUBLIC_SUPABASE_ANON_KEY into the dev server's
 * environment, so nothing key-shaped is ever written to a tracked file. A
 * production build gets it from the deploy pipeline the same way.
 *
 * `$env/dynamic/public` rather than `$env/static/public` deliberately: the static
 * form is a compile error when a variable is absent, which would make
 * `pnpm check:web` depend on a running Supabase stack.
 */

/** Loopback by default so a fresh clone targets the local stack. */
export const supabaseUrl = env.PUBLIC_SUPABASE_URL ?? 'http://127.0.0.1:54421';

export const supabaseAnonKey = env.PUBLIC_SUPABASE_ANON_KEY ?? '';

/**
 * Seeded local user. Only ever used against a loopback host — see
 * `shouldAutoLogin`. Grants access to nothing outside a container on this
 * laptop, which is why it can be committed (CLAUDE.md § local-dev env).
 */
export const devUserEmail = env.PUBLIC_DEV_USER_EMAIL ?? 'investor@test.com';
export const devUserPassword = env.PUBLIC_DEV_USER_PASSWORD ?? 'testtest';
