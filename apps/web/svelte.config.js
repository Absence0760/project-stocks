import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

/**
 * Static only — no SSR, no Node server. `src/routes/+layout.ts` turns SSR off
 * for every route, and the adapter emits `index.html` as an SPA fallback, which
 * is what S3 + CloudFront serves for any path that isn't a real object.
 *
 * A server render would be worse than useless here: every page is behind Supabase
 * auth, so there is nothing to render before the session is known.
 *
 * @type {import('@sveltejs/kit').Config}
 */
export default {
	preprocess: vitePreprocess(),
	kit: {
		adapter: adapter({
			fallback: 'index.html',
			precompress: false
		})
	}
};
