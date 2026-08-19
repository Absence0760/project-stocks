import 'package:flutter/material.dart';

import '../core/formatting.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'models.dart';
import 'portfolio_repository.dart';
import 'position_detail_screen.dart';

class PositionsScreen extends StatefulWidget {
  const PositionsScreen({super.key, required this.repository});

  final PortfolioRepository repository;

  @override
  State<PositionsScreen> createState() => _PositionsScreenState();
}

class _PositionsScreenState extends State<PositionsScreen> {
  late Future<List<Position>> _future;

  @override
  void initState() {
    super.initState();
    _future = widget.repository.positions();
  }

  void _reload() {
    // Block body on purpose: an arrow closure here returns the Future, and
    // setState asserts that its callback returns nothing.
    setState(() {
      _future = widget.repository.positions();
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Portfolio')),
      body: FutureBuilder<List<Position>>(
        future: _future,
        builder: (context, snapshot) {
          if (snapshot.connectionState == ConnectionState.waiting) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) return ErrorState(onRetry: _reload);

          final all = snapshot.data ?? const <Position>[];
          final open = all.where((p) => p.isOpen).toList();
          final closed = all.where((p) => !p.isOpen).toList();

          if (all.isEmpty) {
            return const EmptyState(
              icon: Icons.inbox_outlined,
              message: 'No positions yet.\nImport a broker CSV to get started.',
            );
          }

          return RefreshIndicator(
            onRefresh: () async => _reload(),
            child: ListView(
              children: [
                _PortfolioSummary(positions: all),
                const SectionHeader(title: 'Holdings'),
                for (final position in open)
                  _PositionRow(
                    position: position,
                    repository: widget.repository,
                  ),
                if (closed.isNotEmpty) ...[
                  const SectionHeader(title: 'Closed'),
                  for (final position in closed)
                    _PositionRow(
                      position: position,
                      repository: widget.repository,
                    ),
                ],
                const SizedBox(height: 24),
              ],
            ),
          );
        },
      ),
    );
  }
}

class _PortfolioSummary extends StatelessWidget {
  const _PortfolioSummary({required this.positions});

  final List<Position> positions;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final invested = positions.fold<double>(0, (sum, p) => sum + p.costBasis);
    final realized = positions.fold<double>(0, (sum, p) => sum + p.realizedPl);
    final openCount = positions.where((p) => p.isOpen).length;

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 0),
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              StatTile(label: 'COST BASIS', value: formatMoney(invested)),
              StatTile(
                label: 'REALIZED',
                value: formatSignedMoney(realized),
                tone: realized == 0
                    ? null
                    : realized > 0
                    ? theme.colorScheme.primary
                    : theme.colorScheme.error,
              ),
              StatTile(label: 'HOLDINGS', value: '$openCount'),
            ],
          ),
        ),
      ),
    );
  }
}

class _PositionRow extends StatelessWidget {
  const _PositionRow({required this.position, required this.repository});

  final Position position;
  final PortfolioRepository repository;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);

    return ListTile(
      title: Text(
        position.symbol,
        style: theme.textTheme.titleMedium?.copyWith(
          fontWeight: FontWeight.w600,
        ),
      ),
      subtitle: Text(
        position.isOpen
            ? '${formatShares(position.quantity)} shares'
                  '${position.avgCost == null ? '' : ' · avg ${formatMoney(position.avgCost!)}'}'
            : 'Closed',
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      ),
      trailing: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Text(
            formatMoney(position.costBasis),
            style: theme.textTheme.titleSmall?.merge(tabularFigures),
          ),
          if (position.realizedPl != 0)
            Text(
              formatSignedMoney(position.realizedPl),
              style: theme.textTheme.labelSmall
                  ?.merge(tabularFigures)
                  .copyWith(
                    color: position.realizedPl > 0
                        ? theme.colorScheme.primary
                        : theme.colorScheme.error,
                  ),
            ),
        ],
      ),
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) =>
              PositionDetailScreen(position: position, repository: repository),
        ),
      ),
    );
  }
}
