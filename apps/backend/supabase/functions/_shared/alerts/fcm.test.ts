import { assert, assertEquals } from "@std/assert";
import { FcmPushSender, parseServiceAccount } from "./fcm.ts";
import type { AlertDelivery } from "./types.ts";

const DELIVERY: AlertDelivery = {
  alertEventId: "00000000-0000-0000-0000-0000000000e1",
  userId: "00000000-0000-0000-0000-0000000000a1",
  channel: "push",
  firedAt: "2026-08-19T15:30:00.000Z",
  context: { kind: "price_below", symbol: "AAPL", threshold: 150, price: 148.2 },
  alreadySent: false,
  email: null,
  pushTokens: ["device-1"],
};

/**
 * A throwaway RSA keypair, generated per run. Nothing here is a credential — the
 * key exists for the length of one test process and signs one fake assertion.
 */
async function throwawayServiceAccount() {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  ) as CryptoKeyPair;

  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  let binary = "";
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  const body = btoa(binary).match(/.{1,64}/g)?.join("\n") ?? "";

  return {
    publicKey: pair.publicKey,
    json: JSON.stringify({
      client_email: "alerts@project-stocks.iam.gserviceaccount.test",
      private_key: `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`,
      project_id: "project-stocks-test",
    }),
  };
}

interface Recorded {
  url: string;
  body: string;
}

function senderWith(
  accountJson: string,
  handler: (url: string, init: RequestInit) => Response,
  recorded: Recorded[],
) {
  const account = parseServiceAccount(accountJson)!;
  return new FcmPushSender({
    projectId: "project-stocks-test",
    serviceAccount: account,
    tokenEndpoint: "https://oauth2.test/token",
    fcmBaseUrl: "https://fcm.test",
    now: () => new Date("2026-08-19T15:30:00Z"),
    fetchImpl: (input, init) => {
      const url = String(input);
      const body = init?.body === undefined ? "" : String(init.body);
      recorded.push({ url, body });
      return Promise.resolve(handler(url, init ?? {}));
    },
  });
}

function okHandler(url: string): Response {
  if (url.includes("/token")) {
    return new Response(JSON.stringify({ access_token: "token-1", expires_in: 3600 }), {
      status: 200,
    });
  }
  return new Response(JSON.stringify({ name: "projects/x/messages/1" }), { status: 200 });
}

Deno.test("parseServiceAccount treats absent as 'not configured', not as an error", () => {
  assertEquals(parseServiceAccount(undefined), null);
  assertEquals(parseServiceAccount("   "), null);
});

Deno.test("mints a verifiable RS256 assertion and sends the notification", async () => {
  const account = await throwawayServiceAccount();
  const recorded: Recorded[] = [];

  const outcome = await senderWith(account.json, okHandler, recorded).send(DELIVERY);

  assertEquals(outcome.delivered, true);
  assertEquals(recorded.length, 2);

  // 1. the token exchange
  const assertion = new URLSearchParams(recorded[0].body).get("assertion")!;
  const [header, claims, signature] = assertion.split(".");
  const decode = (part: string) =>
    JSON.parse(atob(part.replace(/-/g, "+").replace(/_/g, "/")));

  assertEquals(decode(header), { alg: "RS256", typ: "JWT" });
  const parsedClaims = decode(claims);
  assertEquals(parsedClaims.iss, "alerts@project-stocks.iam.gserviceaccount.test");
  assertEquals(parsedClaims.aud, "https://oauth2.test/token");
  assertEquals(parsedClaims.scope, "https://www.googleapis.com/auth/firebase.messaging");

  const signatureBytes = Uint8Array.from(
    atob(signature.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
  const verified = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    account.publicKey,
    signatureBytes as BufferSource,
    new TextEncoder().encode(`${header}.${claims}`) as BufferSource,
  );
  assert(verified, "the assertion is not signed by the service account key");

  // 2. the send itself
  assertEquals(recorded[1].url, "https://fcm.test/v1/projects/project-stocks-test/messages:send");
  const message = JSON.parse(recorded[1].body).message;
  assertEquals(message.token, "device-1");
  assertEquals(message.notification.title, "AAPL below 150");
  assertEquals(message.data.alert_event_id, DELIVERY.alertEventId);
});

Deno.test("the access token is minted once and reused across devices", async () => {
  const account = await throwawayServiceAccount();
  const recorded: Recorded[] = [];

  const outcome = await senderWith(account.json, okHandler, recorded)
    .send({ ...DELIVERY, pushTokens: ["device-1", "device-2", "device-3"] });

  assertEquals(outcome.delivered, true);
  assertEquals(recorded.filter((r) => r.url.includes("/token")).length, 1);
  assertEquals(recorded.filter((r) => r.url.includes("messages:send")).length, 3);
});

Deno.test("no registered device is retryable, not a delivery", async () => {
  const account = await throwawayServiceAccount();
  const recorded: Recorded[] = [];

  const outcome = await senderWith(account.json, okHandler, recorded)
    .send({ ...DELIVERY, pushTokens: [] });

  assertEquals(outcome.delivered, false);
  assertEquals(outcome.retryable, true);
  // Not even a token exchange: nothing to send to.
  assertEquals(recorded.length, 0);
});

Deno.test("one live device among stale ones still counts as delivered", async () => {
  const account = await throwawayServiceAccount();
  const recorded: Recorded[] = [];

  const sender = senderWith(account.json, (url, init) => {
    if (url.includes("/token")) return okHandler(url);
    const token = JSON.parse(String(init.body)).message.token;
    return token === "device-2"
      ? new Response("{}", { status: 200 })
      : new Response('{"error":{"status":"UNREGISTERED"}}', { status: 404 });
  }, recorded);

  const outcome = await sender.send({ ...DELIVERY, pushTokens: ["device-1", "device-2"] });
  assertEquals(outcome.delivered, true);
});

Deno.test("every device stale is permanent; an upstream error is retryable", async () => {
  const account = await throwawayServiceAccount();

  const allStale = await senderWith(account.json, (url) =>
    url.includes("/token") ? okHandler(url) : new Response("{}", { status: 404 }), []).send(DELIVERY);
  assertEquals(allStale.delivered, false);
  assertEquals(allStale.retryable, false);

  const upstream = await senderWith(account.json, (url) =>
    url.includes("/token") ? okHandler(url) : new Response("{}", { status: 503 }), []).send(DELIVERY);
  assertEquals(upstream.delivered, false);
  assertEquals(upstream.retryable, true);
});

Deno.test("a failed token exchange does not leak the key into the error", async () => {
  const account = await throwawayServiceAccount();
  const sender = senderWith(
    account.json,
    (url) => url.includes("/token") ? new Response("bad assertion", { status: 400 }) : okHandler(url),
    [],
  );

  const error = await sender.send(DELIVERY).then(() => null, (e: Error) => e);

  assert(error instanceof Error);
  assert(error.message.includes("400"));
  assert(!error.message.includes("PRIVATE KEY"), "the private key reached an error message");
});
