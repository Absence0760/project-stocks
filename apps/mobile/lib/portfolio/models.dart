import '../core/json.dart';

/// A holding, derived from the ledger by recompute_positions().
class Position {
  const Position({
    required this.instrumentId,
    required this.symbol,
    required this.name,
    required this.quantity,
    required this.costBasis,
    required this.avgCost,
    required this.realizedPl,
    required this.firstAcquiredOn,
    required this.lastTransactionOn,
  });

  final String instrumentId;
  final String symbol;
  final String? name;
  final double quantity;
  final double costBasis;
  final double? avgCost;
  final double realizedPl;
  final DateTime? firstAcquiredOn;
  final DateTime? lastTransactionOn;

  /// A fully-sold holding stays in the table so its realized P/L survives.
  bool get isOpen => quantity > 0;

  factory Position.fromJson(Map<String, dynamic> json) {
    // PostgREST embeds the joined instrument under its table name.
    final instrument = json['instruments'] as Map<String, dynamic>?;
    return Position(
      instrumentId: asString(json['instrument_id']),
      symbol: asString(instrument?['symbol'], fallback: '—'),
      name: instrument?['name'] as String?,
      quantity: asDouble(json['quantity']),
      costBasis: asDouble(json['cost_basis']),
      avgCost: asDoubleOrNull(json['avg_cost']),
      realizedPl: asDouble(json['realized_pl']),
      firstAcquiredOn: asDateOrNull(json['first_acquired_on']),
      lastTransactionOn: asDateOrNull(json['last_transaction_on']),
    );
  }
}

/// An open FIFO tax lot.
class PositionLot {
  const PositionLot({
    required this.id,
    required this.acquiredOn,
    required this.quantity,
    required this.costPerShare,
  });

  final String id;
  final DateTime? acquiredOn;
  final double quantity;
  final double costPerShare;

  double get costBasis => quantity * costPerShare;

  factory PositionLot.fromJson(Map<String, dynamic> json) => PositionLot(
    id: asString(json['id']),
    acquiredOn: asDateOrNull(json['acquired_on']),
    quantity: asDouble(json['quantity']),
    costPerShare: asDouble(json['cost_per_share']),
  );
}
