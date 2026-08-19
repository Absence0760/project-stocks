/// Hosts that can only ever be a developer's own machine.
///
/// 10.0.2.2 is the Android emulator's alias for the host loopback;
/// host.docker.internal is the equivalent from inside a container.
const _loopbackHosts = <String>{
  'localhost',
  '127.0.0.1',
  '::1',
  '10.0.2.2',
  'host.docker.internal',
};

/// Whether to silently sign in as the seeded dev user.
///
/// Gated on the *host*, not on a build flag alone: a release build pointed at
/// production must never carry a hardcoded credential, and a debug build pointed
/// at production is exactly the accident this prevents. Callers combine this
/// with `kDebugMode`.
bool shouldAutoLogin({
  required String url,
  required String email,
  required String password,
}) {
  if (email.isEmpty || password.isEmpty) return false;

  final uri = Uri.tryParse(url);
  if (uri == null || uri.host.isEmpty) return false;

  return _loopbackHosts.contains(uri.host);
}
