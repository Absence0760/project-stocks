import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:project_stocks/portfolio/positions_screen.dart';
import 'package:project_stocks/ui/widgets.dart';

import '../support/fake_repository.dart';

Future<void> pumpPositions(
  WidgetTester tester,
  FakePortfolioRepository repo,
) async {
  await tester.pumpWidget(MaterialApp(home: PositionsScreen(repository: repo)));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('lists holdings with their cost basis', (tester) async {
    final repo = FakePortfolioRepository(
      positionsResult: [
        buildPosition(symbol: 'AAPL', costBasis: 1790),
        buildPosition(
          instrumentId: 'inst-2',
          symbol: 'MSFT',
          costBasis: 3200,
          realizedPl: 0,
        ),
      ],
    );

    await pumpPositions(tester, repo);

    expect(find.text('AAPL'), findsOneWidget);
    expect(find.text('MSFT'), findsOneWidget);
    expect(find.text(r'$1,790.00'), findsOneWidget);
    expect(find.text(r'$3,200.00'), findsOneWidget);
  });

  testWidgets('summarises cost basis, realized P/L and holding count', (
    tester,
  ) async {
    final repo = FakePortfolioRepository(
      positionsResult: [
        buildPosition(costBasis: 1790, realizedPl: 240),
        buildPosition(
          instrumentId: 'inst-2',
          symbol: 'MSFT',
          costBasis: 3200,
          realizedPl: 0,
        ),
      ],
    );

    await pumpPositions(tester, repo);

    expect(find.text(r'$4,990.00'), findsOneWidget); // 1790 + 3200
    expect(find.text(r'+$240.00'), findsWidgets);
    expect(find.text('2'), findsOneWidget);
  });

  // A sold-out holding still matters: its realized P/L is part of the record.
  testWidgets('separates closed positions from live holdings', (tester) async {
    final repo = FakePortfolioRepository(
      positionsResult: [
        buildPosition(symbol: 'AAPL'),
        buildPosition(
          instrumentId: 'inst-2',
          symbol: 'TSLA',
          quantity: 0,
          costBasis: 0,
          avgCost: null,
          realizedPl: 512.5,
        ),
      ],
    );

    await pumpPositions(tester, repo);

    // "Closed" also appears as the row subtitle, so match the section header.
    expect(find.widgetWithText(SectionHeader, 'Holdings'), findsOneWidget);
    expect(find.widgetWithText(SectionHeader, 'Closed'), findsOneWidget);
    expect(find.text('1'), findsOneWidget); // only AAPL counts as a holding
  });

  testWidgets('points a new user at the import path when empty', (
    tester,
  ) async {
    await pumpPositions(tester, FakePortfolioRepository());

    expect(find.textContaining('Import a broker CSV'), findsOneWidget);
  });

  testWidgets('offers a retry instead of a raw exception on failure', (
    tester,
  ) async {
    await pumpPositions(tester, FakePortfolioRepository(failsOnRead: true));

    expect(find.text('Try again'), findsOneWidget);
    expect(find.textContaining('Exception'), findsNothing);
  });
}
