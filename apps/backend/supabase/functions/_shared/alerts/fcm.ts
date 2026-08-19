/**
 * FCM HTTP v1 push sender.
 *
 * Firebase is not a dependency of this project — it is an optional delivery
 * channel. Nothing here runs unless `FCM_PROJECT_ID` and `FCM_SERVICE_ACCOUNT`
 * are both set; without them `configured` is false, the worker never claims a
 * push job, and `alert_events.push_sent_at` stays NULL so a later credentialed
 * deploy delivers the backlog.
 *
 * HTTP v1 authenticates with a short-lived OAuth2 access token minted from the
 * service account's private key (the legacy server-key API is retired). That
 * exchange is the RS256 JWT bearer flow, done here with Web Crypto so the
 * function pulls in no npm dependency — see docs/STACK.md on why Deno must not
 * resolve npm packages in this repo.
 *
 * The private key is read from the environment and handed straight to
 * `crypto.subtle`; it is never logged, never written to disk, and never included
 * in an error message.
 */

import { describeAlert } from "./types.ts";
import type { AlertDelivery, AlertSender, DeliveryOutcome } from "./types.ts";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const TOKEN_TTL_SECONDS = 3_600;
/** Re-mint a little early rather than race the expiry mid-pass. */
const TOKEN_REFRESH_MARGIN_MS = 60_000;

export interface FcmServiceAccount {
  clientEmail: string;
  privateKeyPem: string;
  /** The service account's own project, used when FCM_PROJECT_ID is absent. */
  projectId?: string;
}

export class FcmCredentialError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FcmCredentialError";
  }
}

/**
 * Parse a service-account JSON blob.
 *
 * Absent is fine — the channel is simply not configured. Present but malformed
 * is not: it means someone tried to turn push on and got it wrong, and silently
 * treating that as "off" is how an outage lasts a month.
 */
export function parseServiceAccount(raw: string | undefined): FcmServiceAccount | null {
  if (raw === undefined || raw.trim() === "") return null;

  let parsed: { client_email?: string; private_key?: string; project_id?: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new FcmCredentialError("FCM_SERVICE_ACCOUNT is not valid JSON");
  }

  if (!parsed.client_email || !parsed.private_key) {
    throw new FcmCredentialError("FCM_SERVICE_ACCOUNT needs client_email and private_key");
  }

  return {
    clientEmail: parsed.client_email,
    privateKeyPem: parsed.private_key,
    projectId: parsed.project_id,
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function encodeJson(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/** PEM (PKCS#8) → DER. */
function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/, "")
    .replace(/-----END [^-]+-----/, "")
    .replace(/\s+/g, "");
  const binary = atob(body);
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  return der;
}

export interface FcmPushSenderOptions {
  projectId: string;
  serviceAccount: FcmServiceAccount;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  tokenEndpoint?: string;
  fcmBaseUrl?: string;
}

export class FcmPushSender implements AlertSender {
  readonly channel = "push" as const;
  readonly configured = true;

  readonly #projectId: string;
  readonly #account: FcmServiceAccount;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #tokenEndpoint: string;
  readonly #fcmBaseUrl: string;

  #cachedToken: { value: string; expiresAtMs: number } | null = null;

  constructor(options: FcmPushSenderOptions) {
    this.#projectId = options.projectId;
    this.#account = options.serviceAccount;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? (() => new Date());
    this.#tokenEndpoint = options.tokenEndpoint ?? TOKEN_ENDPOINT;
    this.#fcmBaseUrl = (options.fcmBaseUrl ?? "https://fcm.googleapis.com").replace(/\/+$/, "");
  }

  async send(delivery: AlertDelivery): Promise<DeliveryOutcome> {
    if (delivery.pushTokens.length === 0) {
      // Push is on but no device has registered yet. Retryable: the next sign-in
      // writes a token, and the event is still worth delivering when it does.
      return { delivered: false, reason: "no registered device tokens", retryable: true };
    }

    const accessToken = await this.#accessToken();
    const { title, body } = describeAlert(delivery);

    let delivered = 0;
    let stale = 0;
    const errors: string[] = [];

    for (const deviceToken of delivery.pushTokens) {
      const response = await this.#fetch(
        `${this.#fcmBaseUrl}/v1/projects/${encodeURIComponent(this.#projectId)}/messages:send`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            message: {
              token: deviceToken,
              notification: { title, body },
              data: {
                alert_event_id: delivery.alertEventId,
                kind: String(delivery.context.kind ?? ""),
              },
            },
          }),
        },
      );

      if (response.ok) {
        delivered++;
        continue;
      }

      const detail = await response.text();
      // 404 UNREGISTERED / 400 INVALID_ARGUMENT mean this device is gone. That is
      // not a reason to retry the event — it is a reason to drop the token.
      if (response.status === 404 || response.status === 400) {
        stale++;
      } else {
        errors.push(`${response.status} ${detail.slice(0, 200)}`);
      }
    }

    if (delivered > 0) return { delivered: true };

    if (errors.length === 0 && stale > 0) {
      return {
        delivered: false,
        reason: "every registered device token is stale",
        retryable: false,
      };
    }

    return { delivered: false, reason: `FCM refused the send: ${errors.join("; ")}`, retryable: true };
  }

  /** Mint (and cache) an OAuth2 access token from the service-account key. */
  async #accessToken(): Promise<string> {
    const nowMs = this.#now().getTime();
    if (this.#cachedToken && this.#cachedToken.expiresAtMs - TOKEN_REFRESH_MARGIN_MS > nowMs) {
      return this.#cachedToken.value;
    }

    const issuedAt = Math.floor(nowMs / 1000);
    const claims = {
      iss: this.#account.clientEmail,
      scope: FCM_SCOPE,
      aud: this.#tokenEndpoint,
      iat: issuedAt,
      exp: issuedAt + TOKEN_TTL_SECONDS,
    };

    const signingInput = `${encodeJson({ alg: "RS256", typ: "JWT" })}.${encodeJson(claims)}`;

    const key = await crypto.subtle.importKey(
      "pkcs8",
      pemToDer(this.#account.privateKeyPem) as BufferSource,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        key,
        new TextEncoder().encode(signingInput) as BufferSource,
      ),
    );

    const response = await this.#fetch(this.#tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${signingInput}.${base64Url(signature)}`,
      }),
    });

    if (!response.ok) {
      // The response body echoes the request's error code, not the key.
      throw new Error(`FCM token exchange failed: ${response.status}`);
    }

    const body = await response.json() as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error("FCM token exchange returned no access_token");

    this.#cachedToken = {
      value: body.access_token,
      expiresAtMs: nowMs + (body.expires_in ?? TOKEN_TTL_SECONDS) * 1000,
    };
    return body.access_token;
  }
}
