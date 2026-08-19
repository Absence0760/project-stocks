import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

import 'config/env.dart';
import 'core/dev_auto_login.dart';
import 'portfolio/portfolio_repository.dart';
import 'portfolio/positions_screen.dart';
import 'ui/theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();

  await Supabase.initialize(
    url: Env.supabaseUrl,
    publishableKey: Env.supabaseAnonKey,
  );

  // Debug builds pointed at a loopback stack sign in as the seeded user so the
  // app is usable the moment it launches. Both conditions are required: a debug
  // build pointed at production must never use a hardcoded credential.
  if (kDebugMode &&
      shouldAutoLogin(
        url: Env.supabaseUrl,
        email: Env.devUserEmail,
        password: Env.devUserPassword,
      )) {
    final auth = Supabase.instance.client.auth;
    if (auth.currentSession == null) {
      try {
        await auth.signInWithPassword(
          email: Env.devUserEmail,
          password: Env.devUserPassword,
        );
      } catch (error) {
        debugPrint('dev auto-login failed: $error');
      }
    }
  }

  runApp(const ProjectStocksApp());
}

class ProjectStocksApp extends StatelessWidget {
  const ProjectStocksApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Stocks',
      debugShowCheckedModeBanner: false,
      theme: buildTheme(Brightness.light),
      darkTheme: buildTheme(Brightness.dark),
      home: PositionsScreen(
        repository: SupabasePortfolioRepository(Supabase.instance.client),
      ),
    );
  }
}
