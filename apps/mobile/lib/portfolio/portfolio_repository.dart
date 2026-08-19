import 'package:supabase_flutter/supabase_flutter.dart';

import '../journal/models.dart';
import 'models.dart';

/// All reads and writes for the portfolio and journal.
///
/// Every query scopes to the caller implicitly through RLS, but the derived
/// tables are SELECT-only by design: to change a position you change the ledger
/// and recompute. There is deliberately no `updatePosition` here.
///
/// Abstract so the screens can be widget-tested against a fake without a live
/// database — the same seam the backend's LedgerStore uses.
abstract class PortfolioRepository {
  Future<List<Position>> positions();
  Future<Position?> position(String instrumentId);
  Future<List<PositionLot>> lots(String instrumentId);
  Future<List<Thesis>> theses(String instrumentId);
  Future<List<Note>> notes({String? instrumentId});
  Future<void> addNote({String? instrumentId, required String body});
  Future<void> supersedeThesis({
    required String instrumentId,
    required String rationale,
    String? entryConditions,
    String? exitConditions,
    int? conviction,
  });
}

class SupabasePortfolioRepository implements PortfolioRepository {
  const SupabasePortfolioRepository(this._db);

  final SupabaseClient _db;

  static const _positionColumns =
      'instrument_id, quantity, cost_basis, avg_cost, realized_pl, '
      'first_acquired_on, last_transaction_on, instruments(symbol, name)';

  @override
  Future<List<Position>> positions() async {
    final rows = await _db
        .from('positions')
        .select(_positionColumns)
        .order('cost_basis', ascending: false);

    return rows.map(Position.fromJson).toList();
  }

  @override
  Future<Position?> position(String instrumentId) async {
    final rows = await _db
        .from('positions')
        .select(_positionColumns)
        .eq('instrument_id', instrumentId)
        .limit(1);

    return rows.isEmpty ? null : Position.fromJson(rows.first);
  }

  @override
  Future<List<PositionLot>> lots(String instrumentId) async {
    final rows = await _db
        .from('position_lots')
        .select('id, acquired_on, quantity, cost_per_share')
        .eq('instrument_id', instrumentId)
        .order('acquired_on');

    return rows.map(PositionLot.fromJson).toList();
  }

  /// Newest first, so the live thesis leads and history follows.
  @override
  Future<List<Thesis>> theses(String instrumentId) async {
    final rows = await _db
        .from('theses')
        .select(
          'id, instrument_id, rationale, entry_conditions, exit_conditions, '
          'conviction, written_at, superseded_at',
        )
        .eq('instrument_id', instrumentId)
        .order('written_at', ascending: false);

    return rows.map(Thesis.fromJson).toList();
  }

  @override
  Future<List<Note>> notes({String? instrumentId}) async {
    var query = _db.from('notes').select('id, instrument_id, body, created_at');
    if (instrumentId != null) query = query.eq('instrument_id', instrumentId);

    final rows = await query.order('created_at', ascending: false);
    return rows.map(Note.fromJson).toList();
  }

  @override
  Future<void> addNote({String? instrumentId, required String body}) async {
    final userId = _db.auth.currentUser?.id;
    if (userId == null) throw StateError('addNote requires a signed-in user');

    await _db.from('notes').insert({
      'user_id': userId,
      'instrument_id': instrumentId,
      'body': body,
    });
  }

  /// Stamps the current thesis and writes its replacement in one statement — see
  /// supersede_thesis() in the schema. Doing it client-side in two would race the
  /// one-live-thesis unique index.
  @override
  Future<void> supersedeThesis({
    required String instrumentId,
    required String rationale,
    String? entryConditions,
    String? exitConditions,
    int? conviction,
  }) async {
    await _db.rpc(
      'supersede_thesis',
      params: {
        'p_instrument_id': instrumentId,
        'p_rationale': rationale,
        'p_entry_conditions': entryConditions,
        'p_exit_conditions': exitConditions,
        'p_conviction': conviction,
      },
    );
  }
}
