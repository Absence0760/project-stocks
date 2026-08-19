import 'package:intl/intl.dart';

final _money = NumberFormat.currency(locale: 'en_US', symbol: r'$');
final _signedMoney = NumberFormat.currency(locale: 'en_US', symbol: r'$');
final _shares = NumberFormat.decimalPattern('en_US');
final _day = DateFormat.yMMMd('en_US');

String formatMoney(double value) => _money.format(value);

/// Realized P/L reads better with an explicit sign.
String formatSignedMoney(double value) {
  final formatted = _signedMoney.format(value.abs());
  if (value > 0) return '+$formatted';
  if (value < 0) return '-$formatted';
  return formatted;
}

/// Fractional shares are normal, but trailing zeros are noise. Show up to four
/// decimals and drop what isn't needed.
String formatShares(double value) {
  if (value == value.roundToDouble()) return _shares.format(value.round());
  return value
      .toStringAsFixed(4)
      .replaceFirst(RegExp(r'0+$'), '')
      .replaceFirst(RegExp(r'\.$'), '');
}

String formatDate(DateTime? value) => value == null ? '—' : _day.format(value);
