import 'package:flutter_test/flutter_test.dart';
import 'package:project_stocks/core/json.dart';

void main() {
  group('asNum', () {
    test('passes numbers through', () {
      expect(asNum(42), 42);
      expect(asNum(1.5), 1.5);
    });

    // Postgres numeric is often encoded as a string to stay lossless. Casting
    // straight to double would throw inside a list builder.
    test('parses numerics that arrive as strings', () {
      expect(asNum('1790.00000000'), 1790.0);
      expect(asNum('-12.5'), -12.5);
    });

    test('returns null for values that are not numeric', () {
      expect(asNum(null), isNull);
      expect(asNum('not a number'), isNull);
      expect(asNum(''), isNull);
      expect(asNum(<String>[]), isNull);
    });
  });

  group('asDouble', () {
    test('falls back rather than throwing', () {
      expect(asDouble(null), 0);
      expect(asDouble('nope', fallback: -1), -1);
    });

    test('accepts both encodings of the same value', () {
      expect(asDouble('200.00000000'), asDouble(200));
    });
  });

  test('asIntOrNull truncates a numeric string', () {
    expect(asIntOrNull('4'), 4);
    expect(asIntOrNull(null), isNull);
  });

  group('asDateOrNull', () {
    test('parses ISO dates and timestamps', () {
      expect(asDateOrNull('2026-01-12'), DateTime.parse('2026-01-12'));
      expect(
        asDateOrNull('2026-05-04T09:00:00Z'),
        DateTime.parse('2026-05-04T09:00:00Z'),
      );
    });

    test('returns null for blanks and rubbish', () {
      expect(asDateOrNull(null), isNull);
      expect(asDateOrNull(''), isNull);
      expect(asDateOrNull('not a date'), isNull);
    });
  });
}
