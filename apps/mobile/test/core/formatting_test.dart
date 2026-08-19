import 'package:flutter_test/flutter_test.dart';
import 'package:project_stocks/core/formatting.dart';

void main() {
  test('formatMoney renders currency', () {
    expect(formatMoney(1790), r'$1,790.00');
    expect(formatMoney(0), r'$0.00');
  });

  test('formatSignedMoney makes direction explicit', () {
    expect(formatSignedMoney(240), r'+$240.00');
    expect(formatSignedMoney(-240), r'-$240.00');
    expect(formatSignedMoney(0), r'$0.00');
  });

  group('formatShares', () {
    test('drops the decimal for whole share counts', () {
      expect(formatShares(9), '9');
      expect(formatShares(16), '16');
    });

    test('keeps fractional shares without trailing zeros', () {
      expect(formatShares(0.5), '0.5');
      expect(formatShares(1.2345), '1.2345');
      expect(formatShares(2.5000), '2.5');
    });
  });

  test('formatDate renders an em dash for a missing date', () {
    expect(formatDate(null), '—');
    expect(formatDate(DateTime.parse('2026-01-12')), 'Jan 12, 2026');
  });
}
