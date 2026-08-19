import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:project_stocks/journal/models.dart';
import 'package:project_stocks/portfolio/models.dart';
import 'package:project_stocks/portfolio/position_detail_screen.dart';
import 'package:project_stocks/ui/widgets.dart';

import '../support/fake_repository.dart';

Future<void> pumpDetail(
  WidgetTester tester,
  FakePortfolioRepository repo, {
  Position? position,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: PositionDetailScreen(
        position: position ?? buildPosition(),
        repository: repo,
      ),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('shows the position figures', (tester) async {
    await pumpDetail(tester, FakePortfolioRepository());

    expect(find.text('AAPL'), findsOneWidget);
    expect(find.text('9'), findsOneWidget); // shares
    expect(find.text(r'$1,790.00'), findsOneWidget); // cost basis
    expect(find.text(r'+$240.00'), findsOneWidget); // realized
  });

  testWidgets('renders the live thesis with its conditions', (tester) async {
    final repo = FakePortfolioRepository(thesesResult: [buildThesis()]);
    await pumpDetail(tester, repo);

    expect(find.textContaining('Services margin expansion'), findsOneWidget);
    expect(find.textContaining('Add below'), findsOneWidget);
    expect(find.text('Conviction 4/5'), findsOneWidget);
    expect(find.text('Revise'), findsOneWidget);
  });

  // The point of the product: what you believed before stays readable.
  testWidgets('keeps superseded theses under a history section', (
    tester,
  ) async {
    final repo = FakePortfolioRepository(
      thesesResult: [
        buildThesis(id: 't2', rationale: 'Half working now.', conviction: 3),
        buildThesis(
          id: 't1',
          rationale: 'Original bull case.',
          supersededAt: DateTime.utc(2026, 5, 4),
        ),
      ],
    );

    await pumpDetail(tester, repo);

    expect(find.widgetWithText(SectionHeader, 'Previously'), findsOneWidget);
    expect(find.textContaining('Original bull case.'), findsOneWidget);
    expect(find.textContaining('Half working now.'), findsOneWidget);
  });

  testWidgets('prompts for a thesis when none exists', (tester) async {
    await pumpDetail(tester, FakePortfolioRepository());

    expect(find.textContaining('No thesis yet'), findsOneWidget);
    expect(find.text('Write'), findsOneWidget);
  });

  testWidgets('lists FIFO tax lots', (tester) async {
    final repo = FakePortfolioRepository(
      lotsResult: [
        PositionLot(
          id: 'lot-1',
          acquiredOn: DateTime.utc(2026, 1, 12),
          quantity: 4,
          costPerShare: 185,
        ),
        PositionLot(
          id: 'lot-2',
          acquiredOn: DateTime.utc(2026, 2, 18),
          quantity: 5,
          costPerShare: 210,
        ),
      ],
    );

    await pumpDetail(tester, repo);

    expect(find.text(r'4 @ $185.00'), findsOneWidget);
    expect(find.text(r'5 @ $210.00'), findsOneWidget);
    expect(find.text(r'$1,050.00'), findsOneWidget); // 5 * 210
  });

  testWidgets('shows notes newest-first and adds one', (tester) async {
    final repo = FakePortfolioRepository(
      notesResult: [
        Note(
          id: 'n1',
          instrumentId: 'inst-1',
          body: 'Second guidance miss.',
          createdAt: DateTime.utc(2026, 5, 2),
        ),
      ],
    );

    await pumpDetail(tester, repo);
    expect(find.text('Second guidance miss.'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'Trimmed the position.');
    await tester.tap(find.byIcon(Icons.add));
    await tester.pumpAndSettle();

    expect(repo.addedNotes, ['Trimmed the position.']);
    expect(find.text('Trimmed the position.'), findsOneWidget);
  });

  testWidgets('ignores a blank note rather than writing an empty row', (
    tester,
  ) async {
    final repo = FakePortfolioRepository();
    await pumpDetail(tester, repo);

    await tester.enterText(find.byType(TextField), '   ');
    await tester.tap(find.byIcon(Icons.add));
    await tester.pumpAndSettle();

    expect(repo.addedNotes, isEmpty);
  });

  testWidgets('offers a retry instead of a raw exception on failure', (
    tester,
  ) async {
    await pumpDetail(tester, FakePortfolioRepository(failsOnRead: true));

    expect(find.text('Try again'), findsOneWidget);
    expect(find.textContaining('Exception'), findsNothing);
  });
}
