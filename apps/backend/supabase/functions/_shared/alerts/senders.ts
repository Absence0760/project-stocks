/**
 * Delivery channels and how they are chosen.
 *
 * Same shape as the quote provider: an env var per channel, defaulting to a
 * local stub so a fresh clone delivers alerts end-to-end with no SaaS account
 * (CLAUDE.md § "Local-first"). Production names the real sender and supplies its
 * credential.
 *
 * The three states are deliberately distinct:
 *
 *   provider named, credential present  → sends
 *   provider named, credential absent   → `configured: false`; the worker never
 *                                         claims that channel's jobs, so they
 *                                         wait, unstamped, for a credentialed
 *                                         deploy
 *   provider named, credential malformed → throws; someone tried to turn this on
 *                                         and got it wrong, and treating that as
 *                                         "off" hides it for months
 */

import { FcmPushSender, parseServiceAccount } from "./fcm.ts";
import { ResendEmailSender } from "./resend.ts";
import { describeAlert } from "./types.ts";
import type { AlertDelivery, AlertSender, DeliveryOutcome } from "./types.ts";

/** `Deno.env.get`-shaped, so tests pass a plain object lookup. */
export type EnvReader = (key: string) => string | undefined;

export class SenderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SenderConfigError";
  }
}

/**
 * The local equivalent for both channels: it "delivers" by logging.
 *
 * It stamps like a real sender, on purpose — the point of a local equivalent is
 * that the whole path runs, including the idempotency stamp, so the dev loop
 * exercises the same code the deployment will.
 */
export class LoggingSender implements AlertSender {
  readonly configured = true;

  constructor(
    readonly channel: "push" | "email",
    private readonly log: (message: string) => void = console.info,
  ) {}

  send(delivery: AlertDelivery): Promise<DeliveryOutcome> {
    const { title, body } = describeAlert(delivery);
    this.log(
      `[alerts:${this.channel}] ${delivery.userId} ${delivery.alertEventId} — ${title}: ${body}`,
    );
    return Promise.resolve({ delivered: true });
  }
}

/** A sender that is switched off. Present so the pass can report the channel. */
export class UnconfiguredSender implements AlertSender {
  readonly configured = false;

  constructor(readonly channel: "push" | "email", private readonly why: string) {}

  send(): Promise<DeliveryOutcome> {
    // Belt and braces: runDeliveryPass does not claim jobs for an unconfigured
    // channel, so this should be unreachable. If it is ever reached it must not
    // report success — a stamp written here would lose the alert for good.
    return Promise.resolve({ delivered: false, reason: this.why, retryable: true });
  }
}

function createPushSender(env: EnvReader): AlertSender {
  const name = (env("PUSH_PROVIDER") ?? "stub").trim().toLowerCase();

  switch (name) {
    case "stub":
      return new LoggingSender("push");

    case "none":
      return new UnconfiguredSender("push", 'PUSH_PROVIDER="none"');

    case "fcm": {
      // parseServiceAccount throws on malformed JSON; absent is a plain null.
      const account = parseServiceAccount(env("FCM_SERVICE_ACCOUNT"));
      const projectId = env("FCM_PROJECT_ID") ?? account?.projectId;
      if (account === null || !projectId) {
        return new UnconfiguredSender(
          "push",
          "PUSH_PROVIDER=fcm but FCM_SERVICE_ACCOUNT / FCM_PROJECT_ID are not set",
        );
      }
      return new FcmPushSender({ projectId, serviceAccount: account });
    }

    default:
      throw new SenderConfigError(
        `unknown PUSH_PROVIDER "${name}" (expected "stub", "fcm" or "none")`,
      );
  }
}

function createEmailSender(env: EnvReader): AlertSender {
  const name = (env("EMAIL_PROVIDER") ?? "stub").trim().toLowerCase();

  switch (name) {
    case "stub":
      return new LoggingSender("email");

    case "none":
      return new UnconfiguredSender("email", 'EMAIL_PROVIDER="none"');

    case "resend": {
      const apiKey = env("RESEND_API_KEY");
      const from = env("ALERT_EMAIL_FROM");
      if (!apiKey || !from) {
        return new UnconfiguredSender(
          "email",
          "EMAIL_PROVIDER=resend but RESEND_API_KEY / ALERT_EMAIL_FROM are not set",
        );
      }
      return new ResendEmailSender({ apiKey, from });
    }

    default:
      throw new SenderConfigError(
        `unknown EMAIL_PROVIDER "${name}" (expected "stub", "resend" or "none")`,
      );
  }
}

export function createSenders(env: EnvReader): AlertSender[] {
  return [createPushSender(env), createEmailSender(env)];
}
