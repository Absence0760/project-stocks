import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit()],

	// 7777 is this project's web port (docs/STACK.md). strictPort so a second
	// instance fails loudly instead of silently landing on 7778 — a dev server
	// on the wrong port looks exactly like a broken build.
	server: { port: 7777, strictPort: true },
	preview: { port: 7777, strictPort: true },

	test: {
		// Tests live beside the module they cover, so the glob has to recurse.
		include: ['src/**/*.{test,spec}.{js,ts}'],
		environment: 'node'
	}
});
