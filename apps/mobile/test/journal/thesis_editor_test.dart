import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:project_stocks/portfolio/position_detail_screen.dart';

import '../support/fake_repository.dart';

Future<void> openEditor(
  WidgetTester tester,
  FakePortfolioRepository repo,
) async {
  await tester.pumpWidget(
    MaterialApp(
      home: PositionDetailScreen(position: buildPosition(), repository: repo),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.text(repo.thesesResult.isEmpty ? 'Write' : 'Revise'));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('saves a new thesis', (tester) async {
    final repo = FakePortfolioRepository();
    await openEditor(tester, repo);

    await tester.enterText(
      find.widgetWithText(TextField, 'Why do you own this?'),
      'Cloud capex cycle is underappreciated.',
    );
    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(repo.supersededRationales, [
      'Cloud capex cycle is underappreciated.',
    ]);
  });

  testWidgets('refuses a blank rationale', (tester) async {
    final repo = FakePortfolioRepository();
    await openEditor(tester, repo);

    await tester.tap(find.text('Save'));
    await tester.pumpAndSettle();

    expect(repo.supersededRationales, isEmpty);
    expect(find.textContaining('needs a rationale'), findsOneWidget);
  });

  // Revising records a change of mind. Pre-filling the old rationale would
  // invite editing history instead of writing what you now think.
  testWidgets(
    'starts revision from a blank rationale but keeps the conditions',
    (tester) async {
      final repo = FakePortfolioRepository(thesesResult: [buildThesis()]);
      await openEditor(tester, repo);

      expect(find.text('Revise AAPL thesis'), findsOneWidget);
      expect(find.textContaining('kept as history'), findsOneWidget);
      // The detail screen behind the sheet still shows the old thesis, so assert
      // on the editor's own field rather than on the whole tree.
      final rationaleField = tester.widget<TextField>(
        find.widgetWithText(TextField, 'Why do you own this?'),
      );
      expect(rationaleField.controller?.text, isEmpty);
      expect(find.text(r'Add below $180.'), findsOneWidget);
      expect(find.text('Trim on two guidance misses.'), findsOneWidget);
    },
  );
}
