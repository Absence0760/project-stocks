/// Decoding helpers for rows coming back from PostgREST.
///
/// Postgres `numeric` does not always arrive as a JSON number — depending on the
/// column and the client it can be a string, because that is the only lossless
/// JSON encoding for arbitrary precision. Every numeric read goes through here
/// rather than casting, so a `String` where a `double` was expected can't throw
/// at runtime in a list builder.
num? asNum(Object? value) => switch (value) {
  final num n => n,
  final String s => num.tryParse(s),
  _ => null,
};

double asDouble(Object? value, {double fallback = 0}) =>
    asNum(value)?.toDouble() ?? fallback;

double? asDoubleOrNull(Object? value) => asNum(value)?.toDouble();

int? asIntOrNull(Object? value) => asNum(value)?.toInt();

String asString(Object? value, {String fallback = ''}) =>
    value is String ? value : fallback;

DateTime? asDateOrNull(Object? value) {
  if (value is DateTime) return value;
  if (value is! String || value.isEmpty) return null;
  return DateTime.tryParse(value);
}
