/**
 * Resend email sender (https://resend.com/docs/api-reference/emails/send-email).
 *
 * An HTTP API rather than SMTP: the Supabase edge runtime is an HTTP-shaped
 * environment, and an outbound SMTP conversation from a function is both slower
 * and harder to get delivered from than a provider's REST call.
 *
 * Optional, exactly like FCM. Without `RESEND_API_KEY` the channel reports
 * itself unconfigured and its jobs are never claimed, so nothing is stamped and
 * nothing is lost.
 */

import { describeAlert } from "./types.ts";
import type { AlertDelivery, AlertSender, DeliveryOutcome } from "./types.ts";

const DEFAULT_BASE_URL = "https://api.resend.com";

export interface ResendEmailSenderOptions {
  apiKey: string;
  /** A verified sender identity, e.g. "Portfolio <alerts@stocks.example>". */
  from: string;
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export class ResendEmailSender implements AlertSender {
  readonly channel = "email" as const;
  readonly configured = true;

  readonly #apiKey: string;
  readonly #from: string;
  readonly #fetch: typeof fetch;
  readonly #baseUrl: string;

  constructor(options: ResendEmailSenderOptions) {
    this.#apiKey = options.apiKey;
    this.#from = options.from;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  async send(delivery: AlertDelivery): Promise<DeliveryOutcome> {
    if (!delivery.email) {
      // No address on the account. Retrying cannot help until one appears, but
      // it is not permanently wrong either — the user may confirm one tomorrow.
      return { delivered: false, reason: "recipient has no email address", retryable: true };
    }

    const { title, body } = describeAlert(delivery);

    const response = await this.#fetch(`${this.#baseUrl}/emails`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.#apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.#from,
        to: [delivery.email],
        subject: title,
        text: `${body}\n\nFired at ${delivery.firedAt}.`,
      }),
    });

    if (response.ok) return { delivered: true };

    const detail = (await response.text()).slice(0, 200);

    // 4xx other than 429 is a request this send will never get right: a rejected
    // address, an unverified sender, a revoked key. Retrying burns the attempt
    // budget for nothing, so give up and leave the error on the job.
    const retryable = response.status === 429 || response.status >= 500;
    return {
      delivered: false,
      reason: `Resend returned ${response.status}: ${detail}`,
      retryable,
    };
  }
}
