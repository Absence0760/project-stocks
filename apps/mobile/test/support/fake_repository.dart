import 'package:project_stocks/journal/models.dart';
import 'package:project_stocks/portfolio/models.dart';
import 'package:project_stocks/portfolio/portfolio_repository.dart';

/// In-memory repository for widget tests. Records writes so a test can assert
/// what the UI asked for, not just what it rendered.
class FakePortfolioRepository implements PortfolioRepository {
  FakePortfolioRepository({
    this.positionsResult = const [],
    this.lotsResult = const [],
    this.thesesResult = const [],
    this.notesResult = const [],
    this.failsOnRead = false,
  });

  List<Position> positionsResult;
  List<PositionLot> lotsResult;
  List<Thesis> thesesResult;
  List<Note> notesResult;
  bool failsOnRead;

  final List<String> addedNotes = [];
  final List<String> supersededRationales = [];

  @override
  Future<List<Position>> positions() async {
    if (failsOnRead) throw Exception('offline');
    return positionsResult;
  }

  @override
  Future<Position?> position(String instrumentId) async =>
      positionsResult.where((p) => p.instrumentId == instrumentId).firstOrNull;

  @override
  Future<List<PositionLot>> lots(String instrumentId) async {
    if (failsOnRead) throw Exception('offline');
    return lotsResult;
  }

  @override
  Future<List<Thesis>> theses(String instrumentId) async {
    if (failsOnRead) throw Exception('offline');
    return thesesResult;
  }

  @override
  Future<List<Note>> notes({String? instrumentId}) async {
    if (failsOnRead) throw Exception('offline');
    return notesResult;
  }

  @override
  Future<void> addNote({String? instrumentId, required String body}) async {
    addedNotes.add(body);
    notesResult = [
      Note(
        id: 'note-${addedNotes.length}',
        instrumentId: instrumentId,
        body: body,
        createdAt: DateTime.utc(2026, 8, 19),
      ),
      ...notesResult,
    ];
  }

  @override
  Future<void> supersedeThesis({
    required String instrumentId,
    required String rationale,
    String? entryConditions,
    String? exitConditions,
    int? conviction,
  }) async {
    supersededRationales.add(rationale);
  }
}

Position buildPosition({
  String instrumentId = 'inst-1',
  String symbol = 'AAPL',
  String? name = 'Apple Inc.',
  double quantity = 9,
  double costBasis = 1790,
  double? avgCost = 198.89,
  double realizedPl = 240,
}) {
  return Position(
    instrumentId: instrumentId,
    symbol: symbol,
    name: name,
    quantity: quantity,
    costBasis: costBasis,
    avgCost: avgCost,
    realizedPl: realizedPl,
    firstAcquiredOn: DateTime.utc(2026, 1, 12),
    lastTransactionOn: DateTime.utc(2026, 5, 4),
  );
}

Thesis buildThesis({
  String id = 'thesis-1',
  String rationale = 'Services margin expansion is underappreciated.',
  int? conviction = 4,
  DateTime? supersededAt,
}) {
  return Thesis(
    id: id,
    instrumentId: 'inst-1',
    rationale: rationale,
    entryConditions: 'Add below \$180.',
    exitConditions: 'Trim on two guidance misses.',
    conviction: conviction,
    writtenAt: DateTime.utc(2026, 1, 12),
    supersededAt: supersededAt,
  );
}
