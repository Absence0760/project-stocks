import { describe, expect, it } from 'vitest';
import { shouldAutoLogin } from './dev-auto-login';

const email = 'investor@test.com';
const password = 'testtest';

describe('shouldAutoLogin', () => {
	it('allows auto-login against loopback hosts', () => {
		for (const url of [
			'http://127.0.0.1:54421',
			'http://localhost:54421',
			'http://[::1]:54421',
			'http://10.0.2.2:54421', // Android emulator alias for the host
			'http://host.docker.internal:54421'
		]) {
			expect(shouldAutoLogin({ url, email, password }), url).toBe(true);
		}
	});

	// The whole point of the gate: a dev build accidentally pointed at a real
	// project must not send a hardcoded credential to it.
	it('refuses any non-loopback host', () => {
		for (const url of [
			'https://abcdefgh.supabase.co',
			'https://stocks.jaredhoward.com',
			'http://192.168.1.10:54421',
			'http://10.0.2.3:54421',
			'https://127.0.0.1.evil.example.com',
			'https://localhost.evil.example.com',
			'http://127.0.0.1@evil.example.com'
		]) {
			expect(shouldAutoLogin({ url, email, password }), url).toBe(false);
		}
	});

	it('refuses when credentials are absent', () => {
		const url = 'http://127.0.0.1:54421';
		expect(shouldAutoLogin({ url, email: '', password })).toBe(false);
		expect(shouldAutoLogin({ url, email, password: '' })).toBe(false);
	});

	it('refuses an unparseable or hostless url', () => {
		for (const url of ['', 'not a url', '/rest/v1', 'file:///etc/passwd']) {
			expect(shouldAutoLogin({ url, email, password }), url).toBe(false);
		}
	});
});
