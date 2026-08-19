import '../core/json.dart';

/// A written investment thesis. Append-only: superseding writes a new row and
/// stamps the old one, so the history is the feature.
class Thesis {
  const Thesis({
    required this.id,
    required this.instrumentId,
    required this.rationale,
    required this.entryConditions,
    required this.exitConditions,
    required this.conviction,
    required this.writtenAt,
    required this.supersededAt,
  });

  final String id;
  final String instrumentId;
  final String rationale;
  final String? entryConditions;
  final String? exitConditions;
  final int? conviction;
  final DateTime? writtenAt;
  final DateTime? supersededAt;

  bool get isLive => supersededAt == null;

  factory Thesis.fromJson(Map<String, dynamic> json) => Thesis(
    id: asString(json['id']),
    instrumentId: asString(json['instrument_id']),
    rationale: asString(json['rationale']),
    entryConditions: json['entry_conditions'] as String?,
    exitConditions: json['exit_conditions'] as String?,
    conviction: asIntOrNull(json['conviction']),
    writtenAt: asDateOrNull(json['written_at']),
    supersededAt: asDateOrNull(json['superseded_at']),
  );
}

/// A journal entry. A null instrumentId is a portfolio-level note.
class Note {
  const Note({
    required this.id,
    required this.instrumentId,
    required this.body,
    required this.createdAt,
  });

  final String id;
  final String? instrumentId;
  final String body;
  final DateTime? createdAt;

  bool get isPortfolioWide => instrumentId == null;

  factory Note.fromJson(Map<String, dynamic> json) => Note(
    id: asString(json['id']),
    instrumentId: json['instrument_id'] as String?,
    body: asString(json['body']),
    createdAt: asDateOrNull(json['created_at']),
  );
}
