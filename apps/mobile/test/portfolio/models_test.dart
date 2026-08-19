import 'package:flutter_test/flutter_test.dart';
import 'package:project_stocks/journal/models.dart';
import 'package:project_stocks/portfolio/models.dart';

void main() {
  group('Position.fromJson', () {
    test('reads the embedded instrument', () {
      final position = Position.fromJson({
        'instrument_id': 'inst-1',
        'quantity': 9,
        'cost_basis': 1790,
        'avg_cost': 198.8889,
        'realized_pl': 240,
        'first_acquired_on': '2026-01-12',
        'last_transaction_on': '2026-05-04',
        'instruments': {'symbol': 'AAPL', 'name': 'Apple Inc.'},
      });

      expect(position.symbol, 'AAPL');
      expect(position.name, 'Apple Inc.');
      expect(position.quantity, 9);
      expect(position.isOpen, isTrue);
    });

    // Postgres numeric can arrive as a string; the whole row must still parse.
    test('accepts numerics encoded as strings', () {
      final position = Position.fromJson({
        'instrument_id': 'inst-1',
        'quantity': '9.00000000',
        'cost_basis': '1790.00000000',
        'avg_cost': '198.88888889',
        'realized_pl': '240.00000000',
        'instruments': {'symbol': 'AAPL'},
      });

      expect(position.quantity, 9);
      expect(position.costBasis, 1790);
      expect(position.avgCost, closeTo(198.8889, 0.0001));
    });

    test('survives a missing instrument join', () {
      final position = Position.fromJson({
        'instrument_id': 'inst-1',
        'quantity': 0,
        'cost_basis': 0,
        'realized_pl': 0,
      });

      expect(position.symbol, '—');
      expect(position.name, isNull);
      expect(position.avgCost, isNull);
    });

    test('a fully-sold holding is closed but keeps its realized P/L', () {
      final position = Position.fromJson({
        'instrument_id': 'inst-1',
        'quantity': 0,
        'cost_basis': 0,
        'realized_pl': '512.50',
        'instruments': {'symbol': 'TSLA'},
      });

      expect(position.isOpen, isFalse);
      expect(position.realizedPl, 512.5);
    });
  });

  test('PositionLot derives its own cost basis', () {
    final lot = PositionLot.fromJson({
      'id': 'lot-1',
      'acquired_on': '2026-02-18',
      'quantity': '5',
      'cost_per_share': '210',
    });

    expect(lot.costBasis, 1050);
  });

  group('Thesis', () {
    test('is live only until superseded', () {
      expect(
        Thesis.fromJson({
          'id': 't1',
          'rationale': 'x',
          'superseded_at': null,
        }).isLive,
        isTrue,
      );
      expect(
        Thesis.fromJson({
          'id': 't1',
          'rationale': 'x',
          'superseded_at': '2026-05-04T09:00:00Z',
        }).isLive,
        isFalse,
      );
    });
  });

  test('a note without an instrument is portfolio-wide', () {
    expect(Note.fromJson({'id': 'n1', 'body': 'x'}).isPortfolioWide, isTrue);
    expect(
      Note.fromJson({
        'id': 'n1',
        'body': 'x',
        'instrument_id': 'inst-1',
      }).isPortfolioWide,
      isFalse,
    );
  });
}
