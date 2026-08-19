/**
 * Client-rendered SPA, everywhere.
 *
 * Every page is behind Supabase auth and the session lives in browser storage,
 * so a server render has nothing to render — and `adapter-static` has no server
 * to render it on. The adapter emits `index.html` as the fallback shell.
 */
export const ssr = false;
export const prerender = false;
