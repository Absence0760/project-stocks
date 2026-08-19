/// Build-time configuration.
///
/// Values arrive via `--dart-define`, not a bundled asset: the Supabase anon key
/// is injected by `bin/dev-run-mobile.sh`, which reads it straight from
/// `supabase status`. Nothing key-shaped is committed or written to disk.
class Env {
  const Env._();

  /// Loopback by default so a fresh clone targets the local stack. 127.0.0.1
  /// rather than 10.0.2.2 so the same value works on an emulator and a physical
  /// device — the dev script runs `adb reverse` for the ports.
  static const supabaseUrl = String.fromEnvironment(
    'SUPABASE_URL',
    defaultValue: 'http://127.0.0.1:54421',
  );

  static const supabaseAnonKey = String.fromEnvironment('SUPABASE_ANON_KEY');

  /// Seeded local user. Only ever used against a loopback host — see
  /// [shouldAutoLogin]. Grants access to nothing outside a container.
  static const devUserEmail = String.fromEnvironment(
    'DEV_USER_EMAIL',
    defaultValue: 'investor@test.com',
  );
  static const devUserPassword = String.fromEnvironment(
    'DEV_USER_PASSWORD',
    defaultValue: 'testtest',
  );
}
