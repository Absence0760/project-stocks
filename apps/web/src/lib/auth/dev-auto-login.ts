/**
 * Hosts that can only ever be a developer's own machine.
 *
 * 10.0.2.2 is the Android emulator's alias for the host loopback;
 * host.docker.internal is the equivalent from inside a container. Neither is
 * reachable by the web app, but the list is kept identical to
 * apps/mobile/lib/core/dev_auto_login.dart so the two gates can't drift into
 * disagreeing about what "local" means.
 */
const LOOPBACK_HOSTS = new Set<string>([
	'localhost',
	'127.0.0.1',
	'::1',
	'10.0.2.2',
	'host.docker.internal'
]);

export interface AutoLoginCheck {
	url: string;
	email: string;
	password: string;
}

/**
 * Whether to silently sign in as the seeded dev user.
 *
 * Gated on the *host*, not on a build flag alone: a production build must never
 * carry a hardcoded credential, and a dev build accidentally pointed at
 * production is exactly the accident this prevents. Callers combine this with
 * `import.meta.env.DEV`, the web equivalent of Flutter's `kDebugMode`.
 */
export function shouldAutoLogin({ url, email, password }: AutoLoginCheck): boolean {
	if (email === '' || password === '') return false;

	let host: string;
	try {
		// URL() rejects a relative or malformed value by throwing, which is the
		// answer we want anyway.
		host = new URL(url).hostname;
	} catch {
		return false;
	}

	// An IPv6 hostname comes back bracketed (`[::1]`); Dart's Uri.host does not
	// bracket it. Strip them so both clients compare the same string.
	if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

	if (host === '') return false;

	return LOOPBACK_HOSTS.has(host);
}
