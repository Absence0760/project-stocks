import { assert, assertEquals, assertThrows } from "@std/assert";
import { createSenders, LoggingSender, SenderConfigError, UnconfiguredSender } from "./senders.ts";
import { FcmCredentialError } from "./fcm.ts";
import { ResendEmailSender } from "./resend.ts";
import type { AlertDelivery } from "./types.ts";

const env = (values: Record<string, string>) => (key: string) => values[key];

const DELIVERY: AlertDelivery = {
  alertEventId: "00000000-0000-0000-0000-0000000000e1",
  userId: "00000000-0000-0000-0000-0000000000a1",
  channel: "email",
  firedAt: "2026-08-19T15:30:00.000Z",
  context: { kind: "price_above", symbol: "AAPL", threshold: 200, price: 231.5 },
  alreadySent: false,
  email: "investor@test.invalid",
  pushTokens: ["device-1"],
};

Deno.test("both channels default to the local stub so a fresh clone delivers", () => {
  const senders = createSenders(env({}));

  assertEquals(senders.map((s) => s.channel), ["push", "email"]);
  for (const sender of senders) {
    assert(sender.configured, `${sender.channel} should be configured by default`);
    assert(sender instanceof LoggingSender);
  }
});

Deno.test("a named provider with no credential reports itself unconfigured", () => {
  const senders = createSenders(env({ PUSH_PROVIDER: "fcm", EMAIL_PROVIDER: "resend" }));

  for (const sender of senders) {
    assertEquals(sender.configured, false, `${sender.channel} should not be configured`);
  }
});

Deno.test("an unconfigured sender never reports a delivery", async () => {
  const sender = new UnconfiguredSender("push", "no credential");
  const outcome = await sender.send();

  // A `delivered: true` here would stamp push_sent_at and lose the alert.
  assertEquals(outcome.delivered, false);
  assertEquals(outcome.retryable, true);
});

Deno.test("a malformed service account is loud, not quietly 'off'", () => {
  assertThrows(
    () => createSenders(env({ PUSH_PROVIDER: "fcm", FCM_SERVICE_ACCOUNT: "{not json" })),
    FcmCredentialError,
    "not valid JSON",
  );
});

Deno.test("a service account missing its key is refused", () => {
  assertThrows(
    () =>
      createSenders(env({
        PUSH_PROVIDER: "fcm",
        FCM_SERVICE_ACCOUNT: JSON.stringify({ client_email: "a@b.iam.gserviceaccount.com" }),
      })),
    FcmCredentialError,
    "client_email and private_key",
  );
});

Deno.test("an unrecognised provider name is refused rather than defaulted", () => {
  assertThrows(
    () => createSenders(env({ EMAIL_PROVIDER: "sendgrid" })),
    SenderConfigError,
    'unknown EMAIL_PROVIDER "sendgrid"',
  );
});

Deno.test('"none" switches a channel off explicitly', () => {
  const [push] = createSenders(env({ PUSH_PROVIDER: "none" }));
  assertEquals(push.configured, false);
});

Deno.test("resend is selected when its key and sender identity are both present", () => {
  const [, email] = createSenders(env({
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "test-key",
    ALERT_EMAIL_FROM: "Portfolio <alerts@test.invalid>",
  }));

  assert(email instanceof ResendEmailSender);
  assertEquals(email.configured, true);
});

Deno.test("the logging sender delivers and says what it would have sent", async () => {
  const lines: string[] = [];
  const sender = new LoggingSender("email", (line) => lines.push(line));

  const outcome = await sender.send(DELIVERY);

  assertEquals(outcome.delivered, true);
  assert(lines[0].includes("AAPL above 200"));
});

// --- Resend transport ------------------------------------------------------

function resend(status: number, body = "{}", calls: RequestInit[] = []) {
  return new ResendEmailSender({
    apiKey: "test-key",
    from: "Portfolio <alerts@test.invalid>",
    baseUrl: "https://resend.test",
    fetchImpl: (_input, init) => {
      calls.push(init ?? {});
      return Promise.resolve(new Response(body, { status }));
    },
  });
}

Deno.test("a 202 from Resend is a delivery", async () => {
  const calls: RequestInit[] = [];
  const outcome = await resend(202, '{"id":"abc"}', calls).send(DELIVERY);

  assertEquals(outcome.delivered, true);
  const sent = JSON.parse(String(calls[0].body));
  assertEquals(sent.to, ["investor@test.invalid"]);
  assertEquals(sent.subject, "AAPL above 200");
});

Deno.test("a 4xx from Resend is permanent; a 429 or 5xx is retryable", async () => {
  const rejected = await resend(422, '{"message":"unverified sender"}').send(DELIVERY);
  assertEquals(rejected.delivered, false);
  assertEquals(rejected.retryable, false);

  const throttled = await resend(429).send(DELIVERY);
  assertEquals(throttled.retryable, true);

  const upstream = await resend(503).send(DELIVERY);
  assertEquals(upstream.retryable, true);
});

Deno.test("a recipient with no address is not a permanent failure", async () => {
  const outcome = await resend(202).send({ ...DELIVERY, email: null });

  assertEquals(outcome.delivered, false);
  assertEquals(outcome.retryable, true);
});
