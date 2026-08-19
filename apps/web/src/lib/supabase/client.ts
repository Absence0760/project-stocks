import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseAnonKey, supabaseUrl } from '$lib/config/env';

/**
 * The one Supabase client for the app.
 *
 * Created lazily rather than at module load so that importing anything from
 * `$lib` doesn't immediately demand a configured key — the sign-in screen needs
 * to be able to say "the key is missing" instead of dying on import.
 */
let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
	if (client) return client;

	client = createClient(supabaseUrl, supabaseAnonKey, {
		auth: {
			persistSession: true,
			autoRefreshToken: true,
			// Nothing in this app uses an OAuth redirect, and leaving detection on
			// makes the client rewrite the URL on every load.
			detectSessionInUrl: false
		}
	});

	return client;
}

/** True when the launcher failed to pass a publishable key through. */
export function isConfigured(): boolean {
	return supabaseAnonKey !== '';
}
