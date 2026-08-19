import { assert, assertEquals } from "@std/assert";
import { runDeliveryPass } from "./handler.ts";
import type { AlertJobStore, ClaimedJob } from "./store.ts";
import type { AlertChannel, AlertDelivery, AlertSender, DeliveryOutcome } from "./types.ts";

const EVENT = "00000000-0000-0000-0000-0000000000e1";
const USER = "00000000-0000-0000-0000-0000000000a1";

/** Records everything the handler asked of the database. */
class FakeStore implements AlertJobStore {
  readonly calls: string[] = [];
  readonly stamped: Array<{ eventId: string; channel: AlertChannel }> = [];
  readonly finished: Array<{ id: number; status: string; error?: string }> = [];
  readonly deferred: Array<{ id: number; delay: number; error?: string }> = [];

  /** Jobs handed out, in order, per queue kind. */
  queue: ClaimedJob[] = [];
  /** null models "the event no longer exists". */
  delivery: Omit<AlertDelivery, "channel"> | null = {
    alertEventId: EVENT,
    userId: USER,
    firedAt: "2026-08-19T15:30:00.000Z",
    context: { kind: "price_above", symbol: "AAPL", threshold: 200, price: 231.5 },
    alreadySent: false,
    email: "investor@test.invalid",
    pushTokens: ["device-1"],
  };

  claim(_workerId: string, kind: string): Promise<ClaimedJob | null> {
    this.calls.push(`claim:${kind}`);
    const index = this.queue.findIndex((job) => job.kind === kind);
    if (index === -1) return Promise.resolve(null);
    return Promise.resolve(this.queue.splice(index, 1)[0]);
  }

  loadDelivery(alertEventId: string, channel: AlertChannel): Promise<AlertDelivery | null> {
    this.calls.push("loadDelivery");
    if (this.delivery === null) return Promise.resolve(null);
    return Promise.resolve({ ...this.delivery, alertEventId, channel });
  }

  stampDelivered(eventId: string, channel: AlertChannel): Promise<void> {
    this.calls.push("stampDelivered");
    this.stamped.push({ eventId, channel });
    return Promise.resolve();
  }

  finish(id: number, status: "done" | "failed", error?: string): Promise<void> {
    this.calls.push(`finish:${status}`);
    this.finished.push({ id, status, error });
    return Promise.resolve();
  }

  defer(id: number, delay: number, error?: string): Promise<void> {
    this.calls.push("defer");
    this.deferred.push({ id, delay, error });
    return Promise.resolve();
  }
}

class FakeSender implements AlertSender {
  readonly sent: AlertDelivery[] = [];

  constructor(
    readonly channel: AlertChannel,
    readonly configured: boolean,
    private readonly outcome: DeliveryOutcome = { delivered: true },
    /** When set, send() rejects with this message instead of answering. */
    private readonly throws?: string,
  ) {}

  send(delivery: AlertDelivery): Promise<DeliveryOutcome> {
    this.sent.push(delivery);
    if (this.throws !== undefined) return Promise.reject(new Error(this.throws));
    return Promise.resolve(this.outcome);
  }
}

function job(id: number, kind: "alert_push" | "alert_email"): ClaimedJob {
  return { id, kind, payload: { alert_event_id: EVENT, user_id: USER }, attempts: 1 };
}

Deno.test("a delivered alert is stamped and its job finished", async () => {
  const store = new FakeStore();
  store.queue = [job(1, "alert_push")];
  const push = new FakeSender("push", true);

  const result = await runDeliveryPass(store, [push], { workerId: "w1" });

  assertEquals(result.delivered, 1);
  assertEquals(store.stamped, [{ eventId: EVENT, channel: "push" }]);
  assertEquals(store.finished, [{ id: 1, status: "done", error: undefined }]);
  // The stamp lands before the job is closed: a crash between them leaves a
  // visible running job, not a silently undelivered alert.
  assert(store.calls.indexOf("stampDelivered") < store.calls.indexOf("finish:done"));
});

Deno.test("an unconfigured channel is never claimed and never stamped", async () => {
  const store = new FakeStore();
  store.queue = [job(1, "alert_push"), job(2, "alert_email")];
  const push = new FakeSender("push", false);
  const email = new FakeSender("email", true);

  const result = await runDeliveryPass(store, [push, email], { workerId: "w1" });

  assertEquals(result.skippedChannels, ["push"]);
  assertEquals(push.sent.length, 0);
  // The push job is still queued, unattempted, for a credentialed deploy.
  assertEquals(store.calls.filter((c) => c === "claim:alert_push").length, 0);
  assertEquals(store.stamped, [{ eventId: EVENT, channel: "email" }]);
  assertEquals(result.delivered, 1);
});

Deno.test("a refused send defers the job without stamping", async () => {
  const store = new FakeStore();
  store.queue = [job(1, "alert_push")];
  const push = new FakeSender("push", true, {
    delivered: false,
    reason: "no registered device tokens",
    retryable: true,
  });

  const result = await runDeliveryPass(store, [push], { workerId: "w1", retrySeconds: 120 });

  assertEquals(result.deferred, 1);
  assertEquals(store.stamped, []);
  assertEquals(store.deferred, [{ id: 1, delay: 120, error: "no registered device tokens" }]);
});

Deno.test("a permanently-refused send fails the job without stamping", async () => {
  const store = new FakeStore();
  store.queue = [job(1, "alert_email")];
  const email = new FakeSender("email", true, {
    delivered: false,
    reason: "Resend returned 422: unverified sender",
    retryable: false,
  });

  const result = await runDeliveryPass(store, [email], { workerId: "w1" });

  assertEquals(result.failed, 1);
  assertEquals(store.stamped, []);
  assertEquals(store.finished[0].status, "failed");
});

Deno.test("a sender that throws defers with the error recorded, never swallowed", async () => {
  const store = new FakeStore();
  store.queue = [job(1, "alert_push")];
  const push = new FakeSender("push", true, { delivered: true }, "connection reset");

  const result = await runDeliveryPass(store, [push], { workerId: "w1" });

  assertEquals(result.deferred, 1);
  assertEquals(store.stamped, []);
  assertEquals(store.deferred[0].error, "connection reset");
});

Deno.test("an event already stamped for this channel is finished without a second send", async () => {
  const store = new FakeStore();
  store.queue = [job(1, "alert_push")];
  store.delivery = { ...store.delivery!, alreadySent: true };
  const push = new FakeSender("push", true);

  const result = await runDeliveryPass(store, [push], { workerId: "w1" });

  assertEquals(push.sent.length, 0);
  assertEquals(result.alreadyDelivered, 1);
  assertEquals(store.finished[0].status, "done");
});

Deno.test("a job whose event has been deleted fails rather than retrying forever", async () => {
  const store = new FakeStore();
  store.queue = [job(1, "alert_email")];
  store.delivery = null;
  const email = new FakeSender("email", true);

  const result = await runDeliveryPass(store, [email], { workerId: "w1" });

  assertEquals(result.failed, 1);
  assertEquals(store.deferred, []);
  assert(store.finished[0].error?.includes("no longer exists"));
});

Deno.test("a malformed payload fails without touching the sender", async () => {
  const store = new FakeStore();
  store.queue = [{ id: 1, kind: "alert_push", payload: {}, attempts: 1 }];
  const push = new FakeSender("push", true);

  const result = await runDeliveryPass(store, [push], { workerId: "w1" });

  assertEquals(result.failed, 1);
  assertEquals(push.sent.length, 0);
  assertEquals(store.finished[0].error, "payload has no alert_event_id");
});

Deno.test("the pass drains both channels and stops when the queue is dry", async () => {
  const store = new FakeStore();
  store.queue = [job(1, "alert_push"), job(2, "alert_push"), job(3, "alert_email")];

  const result = await runDeliveryPass(
    store,
    [new FakeSender("push", true), new FakeSender("email", true)],
    { workerId: "w1" },
  );

  assertEquals(result.claimed, 3);
  assertEquals(result.delivered, 3);
  assertEquals(store.stamped.map((s) => s.channel), ["push", "push", "email"]);
});

Deno.test("maxJobs bounds one pass so an invocation cannot run forever", async () => {
  const store = new FakeStore();
  store.queue = [job(1, "alert_push"), job(2, "alert_push"), job(3, "alert_push")];

  const result = await runDeliveryPass(store, [new FakeSender("push", true)], {
    workerId: "w1",
    maxJobs: 2,
  });

  assertEquals(result.claimed, 2);
  assertEquals(store.queue.length, 1);
});
