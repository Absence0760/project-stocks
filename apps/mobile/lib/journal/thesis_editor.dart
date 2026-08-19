import 'package:flutter/material.dart';

import '../portfolio/portfolio_repository.dart';
import 'models.dart';

/// Writes or revises a thesis. Returns true if something was saved.
///
/// Revising deliberately starts from a blank rationale rather than pre-filling
/// the old one: this writes a NEW thesis and stamps the old, and pre-filling
/// invites editing history rather than recording a change of mind. The entry and
/// exit conditions do carry over, since those are usually still what you meant.
Future<bool?> showThesisEditor({
  required BuildContext context,
  required PortfolioRepository repository,
  required String instrumentId,
  required String symbol,
  Thesis? current,
}) {
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    builder: (context) => Padding(
      padding: EdgeInsets.only(
        bottom: MediaQuery.of(context).viewInsets.bottom,
      ),
      child: _ThesisEditor(
        repository: repository,
        instrumentId: instrumentId,
        symbol: symbol,
        current: current,
      ),
    ),
  );
}

class _ThesisEditor extends StatefulWidget {
  const _ThesisEditor({
    required this.repository,
    required this.instrumentId,
    required this.symbol,
    this.current,
  });

  final PortfolioRepository repository;
  final String instrumentId;
  final String symbol;
  final Thesis? current;

  @override
  State<_ThesisEditor> createState() => _ThesisEditorState();
}

class _ThesisEditorState extends State<_ThesisEditor> {
  late final TextEditingController _rationale;
  late final TextEditingController _entry;
  late final TextEditingController _exit;
  late int _conviction;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _rationale = TextEditingController();
    _entry = TextEditingController(text: widget.current?.entryConditions ?? '');
    _exit = TextEditingController(text: widget.current?.exitConditions ?? '');
    _conviction = widget.current?.conviction ?? 3;
  }

  @override
  void dispose() {
    _rationale.dispose();
    _entry.dispose();
    _exit.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    final rationale = _rationale.text.trim();
    if (rationale.isEmpty) {
      setState(() => _error = 'A thesis needs a rationale.');
      return;
    }

    setState(() {
      _saving = true;
      _error = null;
    });

    try {
      await widget.repository.supersedeThesis(
        instrumentId: widget.instrumentId,
        rationale: rationale,
        entryConditions: _blankToNull(_entry.text),
        exitConditions: _blankToNull(_exit.text),
        conviction: _conviction,
      );
      if (mounted) Navigator.of(context).pop(true);
    } catch (_) {
      if (mounted) {
        setState(() {
          _saving = false;
          _error = "Couldn't save. Check your connection and try again.";
        });
      }
    }
  }

  static String? _blankToNull(String value) {
    final trimmed = value.trim();
    return trimmed.isEmpty ? null : trimmed;
  }

  @override
  Widget build(BuildContext context) {
    final revising = widget.current != null;

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 24),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              revising
                  ? 'Revise ${widget.symbol} thesis'
                  : 'Write ${widget.symbol} thesis',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            if (revising) ...[
              const SizedBox(height: 4),
              Text(
                'Your current thesis is kept as history.',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
            const SizedBox(height: 16),
            TextField(
              controller: _rationale,
              autofocus: true,
              minLines: 3,
              maxLines: 8,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(
                labelText: 'Why do you own this?',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _entry,
              decoration: const InputDecoration(
                labelText: 'Entry conditions (optional)',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _exit,
              decoration: const InputDecoration(
                labelText: 'Exit conditions (optional)',
                border: OutlineInputBorder(),
                helperText: 'What would make you sell?',
              ),
            ),
            const SizedBox(height: 16),
            Text('Conviction', style: Theme.of(context).textTheme.labelMedium),
            Slider(
              value: _conviction.toDouble(),
              min: 1,
              max: 5,
              divisions: 4,
              label: '$_conviction',
              onChanged: (value) => setState(() => _conviction = value.round()),
            ),
            if (_error != null) ...[
              const SizedBox(height: 8),
              Text(
                _error!,
                style: TextStyle(color: Theme.of(context).colorScheme.error),
              ),
            ],
            const SizedBox(height: 16),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: _saving
                      ? null
                      : () => Navigator.of(context).pop(false),
                  child: const Text('Cancel'),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: _saving ? null : _save,
                  child: Text(_saving ? 'Saving…' : 'Save'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
