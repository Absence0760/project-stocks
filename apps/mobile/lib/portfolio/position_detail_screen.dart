import 'package:flutter/material.dart';

import '../core/formatting.dart';
import '../journal/models.dart';
import '../journal/thesis_editor.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'models.dart';
import 'portfolio_repository.dart';

/// Everything loaded for one position, fetched together so the screen renders in
/// a single pass rather than three staggered spinners.
class _Detail {
  const _Detail({
    required this.lots,
    required this.theses,
    required this.notes,
  });

  final List<PositionLot> lots;
  final List<Thesis> theses;
  final List<Note> notes;

  Thesis? get liveThesis => theses.where((t) => t.isLive).firstOrNull;
  List<Thesis> get history => theses.where((t) => !t.isLive).toList();
}

class PositionDetailScreen extends StatefulWidget {
  const PositionDetailScreen({
    super.key,
    required this.position,
    required this.repository,
  });

  final Position position;
  final PortfolioRepository repository;

  @override
  State<PositionDetailScreen> createState() => _PositionDetailScreenState();
}

class _PositionDetailScreenState extends State<PositionDetailScreen> {
  late Future<_Detail> _future;
  final _noteController = TextEditingController();
  bool _savingNote = false;

  String get _instrumentId => widget.position.instrumentId;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  @override
  void dispose() {
    _noteController.dispose();
    super.dispose();
  }

  Future<_Detail> _load() async {
    final results = await Future.wait([
      widget.repository.lots(_instrumentId),
      widget.repository.theses(_instrumentId),
      widget.repository.notes(instrumentId: _instrumentId),
    ]);

    return _Detail(
      lots: results[0] as List<PositionLot>,
      theses: results[1] as List<Thesis>,
      notes: results[2] as List<Note>,
    );
  }

  void _reload() {
    // Block body on purpose: an arrow closure here returns the Future, and
    // setState asserts that its callback returns nothing.
    setState(() {
      _future = _load();
    });
  }

  Future<void> _addNote() async {
    final body = _noteController.text.trim();
    if (body.isEmpty || _savingNote) return;

    setState(() => _savingNote = true);
    try {
      await widget.repository.addNote(instrumentId: _instrumentId, body: body);
      _noteController.clear();
      _reload();
    } finally {
      if (mounted) setState(() => _savingNote = false);
    }
  }

  Future<void> _editThesis(Thesis? current) async {
    final saved = await showThesisEditor(
      context: context,
      repository: widget.repository,
      instrumentId: _instrumentId,
      symbol: widget.position.symbol,
      current: current,
    );
    if (saved == true) _reload();
  }

  @override
  Widget build(BuildContext context) {
    final position = widget.position;

    return Scaffold(
      appBar: AppBar(
        title: Text(position.symbol),
        bottom: position.name == null
            ? null
            : PreferredSize(
                preferredSize: const Size.fromHeight(20),
                child: Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text(
                    position.name!,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ),
              ),
      ),
      body: FutureBuilder<_Detail>(
        future: _future,
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) return ErrorState(onRetry: _reload);

          final detail = snapshot.data!;
          return ListView(
            children: [
              _PositionHeader(position: position),
              SectionHeader(
                title: 'Thesis',
                action: TextButton(
                  onPressed: () => _editThesis(detail.liveThesis),
                  child: Text(detail.liveThesis == null ? 'Write' : 'Revise'),
                ),
              ),
              if (detail.liveThesis == null)
                const EmptyState(
                  message:
                      "No thesis yet. Write down why you own this — "
                      "it's what you'll want six months from now.",
                )
              else
                _ThesisCard(thesis: detail.liveThesis!, isLive: true),
              if (detail.history.isNotEmpty) ...[
                const SectionHeader(title: 'Previously'),
                for (final thesis in detail.history)
                  _ThesisCard(thesis: thesis, isLive: false),
              ],
              if (detail.lots.isNotEmpty) ...[
                const SectionHeader(title: 'Tax lots (FIFO)'),
                for (final lot in detail.lots) _LotRow(lot: lot),
              ],
              const SectionHeader(title: 'Notes'),
              _NoteComposer(
                controller: _noteController,
                saving: _savingNote,
                onSubmit: _addNote,
              ),
              if (detail.notes.isEmpty)
                const EmptyState(message: 'No notes on this position yet.')
              else
                for (final note in detail.notes) _NoteRow(note: note),
              const SizedBox(height: 32),
            ],
          );
        },
      ),
    );
  }
}

class _PositionHeader extends StatelessWidget {
  const _PositionHeader({required this.position});

  final Position position;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  StatTile(
                    label: 'SHARES',
                    value: formatShares(position.quantity),
                  ),
                  StatTile(
                    label: 'COST BASIS',
                    value: formatMoney(position.costBasis),
                  ),
                  StatTile(
                    label: 'AVG COST',
                    value: position.avgCost == null
                        ? '—'
                        : formatMoney(position.avgCost!),
                  ),
                ],
              ),
              if (position.realizedPl != 0) ...[
                const SizedBox(height: 16),
                StatTile(
                  label: 'REALIZED P/L',
                  value: formatSignedMoney(position.realizedPl),
                  tone: position.realizedPl > 0
                      ? theme.colorScheme.primary
                      : theme.colorScheme.error,
                ),
              ],
              const SizedBox(height: 12),
              Text(
                'Held since ${formatDate(position.firstAcquiredOn)}',
                style: theme.textTheme.bodySmall?.copyWith(
                  color: theme.colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _ThesisCard extends StatelessWidget {
  const _ThesisCard({required this.thesis, required this.isLive});

  final Thesis thesis;
  final bool isLive;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text(
                    isLive
                        ? 'Written ${formatDate(thesis.writtenAt)}'
                        : '${formatDate(thesis.writtenAt)} — superseded ${formatDate(thesis.supersededAt)}',
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: theme.colorScheme.onSurfaceVariant,
                    ),
                  ),
                  const Spacer(),
                  if (thesis.conviction != null)
                    Text(
                      'Conviction ${thesis.conviction}/5',
                      style: theme.textTheme.labelSmall,
                    ),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                thesis.rationale,
                style: isLive
                    ? theme.textTheme.bodyMedium
                    : theme.textTheme.bodyMedium?.copyWith(
                        color: theme.colorScheme.onSurfaceVariant,
                      ),
              ),
              if (thesis.entryConditions != null)
                _Condition(label: 'Entry', value: thesis.entryConditions!),
              if (thesis.exitConditions != null)
                _Condition(label: 'Exit', value: thesis.exitConditions!),
            ],
          ),
        ),
      ),
    );
  }
}

class _Condition extends StatelessWidget {
  const _Condition({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.only(top: 8),
      child: Text.rich(
        TextSpan(
          children: [
            TextSpan(
              text: '$label: ',
              style: const TextStyle(fontWeight: FontWeight.w700),
            ),
            TextSpan(text: value),
          ],
        ),
        style: theme.textTheme.bodySmall,
      ),
    );
  }
}

class _LotRow extends StatelessWidget {
  const _LotRow({required this.lot});

  final PositionLot lot;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      dense: true,
      title: Text(
        '${formatShares(lot.quantity)} @ ${formatMoney(lot.costPerShare)}',
        style: tabularFigures,
      ),
      subtitle: Text('Acquired ${formatDate(lot.acquiredOn)}'),
      trailing: Text(formatMoney(lot.costBasis), style: tabularFigures),
    );
  }
}

class _NoteComposer extends StatelessWidget {
  const _NoteComposer({
    required this.controller,
    required this.saving,
    required this.onSubmit,
  });

  final TextEditingController controller;
  final bool saving;
  final VoidCallback onSubmit;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Expanded(
            child: TextField(
              controller: controller,
              minLines: 1,
              maxLines: 4,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(
                hintText: 'Add a note…',
                border: OutlineInputBorder(),
                isDense: true,
              ),
              onSubmitted: (_) => onSubmit(),
            ),
          ),
          const SizedBox(width: 8),
          IconButton.filled(
            onPressed: saving ? null : onSubmit,
            icon: saving
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.add),
          ),
        ],
      ),
    );
  }
}

class _NoteRow extends StatelessWidget {
  const _NoteRow({required this.note});

  final Note note;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return ListTile(
      title: Text(note.body, style: theme.textTheme.bodyMedium),
      subtitle: Text(formatDate(note.createdAt)),
    );
  }
}
