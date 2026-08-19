/**
 * The consent gate for sending a portfolio to a model.
 *
 * Running a digest ships holdings, theses and private journal notes to a model
 * process. That is exactly the case a disclosure exists for, so the check lives
 * on the server: a UI-only gate is a suggestion, and the edge function is
 * reachable with nothing but a token.
 *
 * The ladder is versioned. `REQUIRED_DISCLOSURE_VERSION` is the single source of
 * truth (`ai_disclosure_acceptances.version` in the migration points here), and
 * an acceptance of an older version does not satisfy a newer requirement —
 * agreeing to v1's text is not agreement to v2's.
 *
 * It is fail-closed in both directions: no acceptance refuses, and a stale
 * acceptance refuses. There is no "unknown" branch that proceeds.
 */

/**
 * Bump this whenever the disclosure text changes materially — a new provider, a
 * new class of data leaving the machine, a change of retention. Bumping
 * re-prompts every user, which is the intended cost.
 */
export const REQUIRED_DISCLOSURE_VERSION = 1;

/**
 * What version 1 covers, kept beside the number so a bump is a reviewable diff
 * rather than an unexplained increment. The UI renders its own copy of this; the
 * canonical statement of *what was agreed to at each version* is here.
 */
export const DISCLOSURE_VERSIONS: Readonly<Record<number, string>> = {
  1: [
    "Generating a digest sends your positions, the theses you have written, and",
    "your recent notes to a language model for summarising.",
    "By default that model runs locally on this machine (Ollama) and nothing",
    "leaves it. If the operator configures a hosted provider instead, the same",
    "data is sent to that provider over the network.",
    "The assistant never places trades, never receives your credentials, and is",
    "not asked to predict prices or recommend buying or selling.",
    "Each response is stored with the exact data it was generated from so you can",
    "review it later; you can delete any stored digest.",
  ].join(" "),
};

export class DisclosureNotAcceptedError extends Error {
  constructor(
    readonly requiredVersion: number,
    readonly acceptedVersion: number | null,
  ) {
    super(
      acceptedVersion === null
        ? `the AI disclosure (version ${requiredVersion}) has not been accepted`
        : `the accepted AI disclosure (version ${acceptedVersion}) is older than the required version ${requiredVersion}`,
    );
    this.name = "DisclosureNotAcceptedError";
  }
}

/**
 * `accepted` is the highest version the user has on record, or null for none.
 *
 * Deliberately a `>=` against the required version rather than an equality: a
 * user who accepted a *newer* disclosure than this deployment requires (an older
 * function still running after a rollback) has plainly consented to at least
 * this much.
 */
export function isDisclosureAccepted(
  accepted: number | null,
  required: number = REQUIRED_DISCLOSURE_VERSION,
): boolean {
  return accepted !== null && accepted >= required;
}
