/**
 * Shared alert types.
 *
 * Two of these unions are paired to CHECK constraints in
 * supabase/migrations/20260819140000_quotes_and_alerts.sql:
 *
 *   ALERT_KINDS → alert_rules.kind
 *   JOB_KINDS   → jobs.kind
 *
 * scripts/check_constraint_unions.mjs fails CI when only one side of a pair
 * moves. For `jobs.kind` that guard is doing real work: a fan-out that enqueues
 * a kind the CHECK rejects aborts the scan's whole transaction, and a worker
 * that dispatches on a kind nothing enqueues is dead code that looks alive.
 */

export const ALERT_KINDS = [
  "price_above",
  "price_below",
  "pct_move",
  "thesis_review",
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const JOB_KINDS = ["alert_push", "alert_email"] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const ALERT_CHANNELS = ["push", "email"] as const;
export type AlertChannel = (typeof ALERT_CHANNELS)[number];

/** The channel ↔ queue-kind mapping the fan-out trigger writes in SQL. */
export const CHANNEL_JOB_KIND: Record<AlertChannel, JobKind> = {
  push: "alert_push",
  email: "alert_email",
};

/** Everything one send needs, as returned by the `alert_delivery()` RPC. */
export interface AlertDelivery {
  alertEventId: string;
  userId: string;
  channel: AlertChannel;
  firedAt: string;
  /** The numbers that made the condition true. Rendered into the message. */
  context: Record<string, unknown>;
  /**
   * This channel has already stamped this event. The worker finishes the job
   * without sending — the re-drain case after a crash between stamp and finish.
   */
  alreadySent: boolean;
  email: string | null;
  /** FCM registration tokens from the recipient's alert_preferences row. */
  pushTokens: string[];
}

export interface DeliveryOutcome {
  delivered: boolean;
  /** Why not, when not. Recorded on the job as last_error. */
  reason?: string;
  /**
   * Whether trying again could work. Defaults to true when absent: a job is
   * only given up on when something is known to be permanently wrong with it.
   */
  retryable?: boolean;
}

export interface AlertSender {
  readonly channel: AlertChannel;
  /**
   * False when the credential this channel needs is absent.
   *
   * An unconfigured sender is never asked to send *and its jobs are never
   * claimed*, so they sit in the queue at `attempts = 0` with no `*_sent_at`
   * stamp until a credentialed deploy drains them. Burning the attempt budget
   * against a missing credential would turn "not configured yet" into "silently
   * lost", which is the failure this flag exists to prevent.
   */
  readonly configured: boolean;
  send(delivery: AlertDelivery): Promise<DeliveryOutcome>;
}

/** Human-readable one-liner for an event, shared by every channel. */
export function describeAlert(delivery: AlertDelivery): { title: string; body: string } {
  const context = delivery.context;
  const symbol = typeof context.symbol === "string" ? context.symbol : "your portfolio";
  const kind = typeof context.kind === "string" ? context.kind : "alert";
  const price = context.price;
  const threshold = context.threshold;
  const pctChange = context.pct_change;

  switch (kind) {
    case "price_above":
      return { title: `${symbol} above ${threshold}`, body: `${symbol} is trading at ${price}.` };
    case "price_below":
      return { title: `${symbol} below ${threshold}`, body: `${symbol} is trading at ${price}.` };
    case "pct_move":
      return {
        title: `${symbol} moved ${pctChange}%`,
        body: `${symbol} is trading at ${price}, against a reference of ${context.reference_price}.`,
      };
    case "thesis_review":
      return {
        title: `Thesis review due${symbol === "your portfolio" ? "" : `: ${symbol}`}`,
        body: typeof context.note === "string" && context.note !== ""
          ? context.note
          : "Scheduled review of what you believed when you bought it.",
      };
    default:
      return { title: "Portfolio alert", body: `An alert fired at ${delivery.firedAt}.` };
  }
}
