/**
 * The delivery worker, written against AlertJobStore + AlertSender so every
 * decision it makes is unit-testable without a database, a queue, or a network.
 *
 * The decisions are the whole point:
 *
 *   * An unconfigured channel's jobs are never claimed. Not claimed, not
 *     attempted, not stamped — they sit at `attempts = 0` until a credentialed
 *     deploy drains them. Claiming and failing would burn the attempt budget and
 *     turn "Firebase is not set up yet" into "these alerts are gone".
 *   * `*_sent_at` is stamped only after a send actually succeeded. There is no
 *     path where a refusal, a throw, or a missing credential writes a stamp.
 *   * The stamp is written before the job is finished. A crash in between leaves
 *     a job stuck in `running` — visible, and re-runnable, because a re-drained
 *     job sees `alreadySent` and finishes without a second send. The other order
 *     would lose the delivery silently, which is the worse failure.
 */

import { CHANNEL_JOB_KIND } from "./types.ts";
import type { AlertChannel, AlertSender } from "./types.ts";
import type { AlertJobStore, ClaimedJob } from "./store.ts";

/** How long an unsendable-but-retryable job waits. Five minutes of backoff. */
const DEFAULT_RETRY_SECONDS = 300;

/** Bound on one pass, so an edge-function invocation cannot run forever. */
const DEFAULT_MAX_JOBS = 50;

export interface DeliveryPassOptions {
  workerId: string;
  maxJobs?: number;
  retrySeconds?: number;
}

export interface DeliveryPassResult {
  claimed: number;
  delivered: number;
  /** Already stamped by an earlier attempt; finished without re-sending. */
  alreadyDelivered: number;
  deferred: number;
  failed: number;
  /** Channels skipped because their credential is absent. */
  skippedChannels: AlertChannel[];
}

export async function runDeliveryPass(
  store: AlertJobStore,
  senders: AlertSender[],
  options: DeliveryPassOptions,
): Promise<DeliveryPassResult> {
  const maxJobs = options.maxJobs ?? DEFAULT_MAX_JOBS;
  const retrySeconds = options.retrySeconds ?? DEFAULT_RETRY_SECONDS;

  const result: DeliveryPassResult = {
    claimed: 0,
    delivered: 0,
    alreadyDelivered: 0,
    deferred: 0,
    failed: 0,
    skippedChannels: senders.filter((s) => !s.configured).map((s) => s.channel),
  };

  let budget = maxJobs;

  for (const sender of senders) {
    if (!sender.configured) continue;

    while (budget > 0) {
      const job = await store.claim(options.workerId, CHANNEL_JOB_KIND[sender.channel]);
      if (job === null) break;

      budget--;
      result.claimed++;
      await deliverOne(store, sender, job, retrySeconds, result);
    }
  }

  return result;
}

async function deliverOne(
  store: AlertJobStore,
  sender: AlertSender,
  job: ClaimedJob,
  retrySeconds: number,
  result: DeliveryPassResult,
): Promise<void> {
  const alertEventId = job.payload.alert_event_id;
  if (typeof alertEventId !== "string" || alertEventId === "") {
    // Nothing to send to. Retrying cannot fix a malformed payload.
    await store.finish(job.id, "failed", "payload has no alert_event_id");
    result.failed++;
    return;
  }

  const delivery = await store.loadDelivery(alertEventId, sender.channel);
  if (delivery === null) {
    // The event was deleted (the rule went, and the cascade took it). The job is
    // moot rather than broken, but there is nothing left to deliver.
    await store.finish(job.id, "failed", `alert event ${alertEventId} no longer exists`);
    result.failed++;
    return;
  }

  if (delivery.alreadySent) {
    await store.finish(job.id, "done", "already delivered on this channel");
    result.alreadyDelivered++;
    return;
  }

  let outcome;
  try {
    outcome = await sender.send(delivery);
  } catch (error) {
    // Not swallowed: the message lands on the job as last_error, the job goes
    // back on the queue, and the attempt counter bounds how long that repeats.
    const message = error instanceof Error ? error.message : String(error);
    await store.defer(job.id, retrySeconds, message);
    result.deferred++;
    return;
  }

  if (outcome.delivered) {
    await store.stampDelivered(alertEventId, sender.channel);
    await store.finish(job.id, "done");
    result.delivered++;
    return;
  }

  if (outcome.retryable === false) {
    await store.finish(job.id, "failed", outcome.reason);
    result.failed++;
    return;
  }

  await store.defer(job.id, retrySeconds, outcome.reason);
  result.deferred++;
}
