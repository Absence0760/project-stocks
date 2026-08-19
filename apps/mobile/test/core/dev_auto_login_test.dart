import 'package:flutter_test/flutter_test.dart';
import 'package:project_stocks/core/dev_auto_login.dart';

void main() {
  const email = 'investor@test.com';
  const password = 'testtest';

  test('allows auto-login against loopback hosts', () {
    for (final url in [
      'http://127.0.0.1:54421',
      'http://localhost:54421',
      'http://10.0.2.2:54421', // Android emulator alias for the host
      'http://host.docker.internal:54421',
    ]) {
      expect(
        shouldAutoLogin(url: url, email: email, password: password),
        isTrue,
        reason: url,
      );
    }
  });

  // The whole point of the gate: a debug build accidentally pointed at a real
  // project must not send a hardcoded credential to it.
  test('refuses any non-loopback host', () {
    for (final url in [
      'https://abcdefgh.supabase.co',
      'https://stocks.jaredhoward.com',
      'http://192.168.1.10:54421',
    ]) {
      expect(
        shouldAutoLogin(url: url, email: email, password: password),
        isFalse,
        reason: url,
      );
    }
  });

  test('refuses when credentials are absent', () {
    const url = 'http://127.0.0.1:54421';
    expect(shouldAutoLogin(url: url, email: '', password: password), isFalse);
    expect(shouldAutoLogin(url: url, email: email, password: ''), isFalse);
  });

  test('refuses an unparseable or hostless url', () {
    expect(shouldAutoLogin(url: '', email: email, password: password), isFalse);
    expect(
      shouldAutoLogin(url: 'not a url', email: email, password: password),
      isFalse,
    );
  });
}
