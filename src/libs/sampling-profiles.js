/**
 * One sampling setting per *kind of thinking*, instead of one per session.
 *
 * Every MiniPhi model call used to run at the same temperature (0.2 for the
 * agent loop, 0 for the reference composer and the vision reviewer, whatever
 * the server defaulted to elsewhere). That is two mistakes at once: the turn
 * that must *choose an approach* is sampled as if it were extracting a field,
 * so a local model reliably re-proposes the approach that just failed; and the
 * turn that must emit 200 lines of JavaScript is sampled loose enough to
 * invent a plausible-looking API that does not exist.
 *
 * The profiles below are deliberately few and named after the job, so a caller
 * picks one by saying what the call is for rather than by tuning a number.
 */

export const SAMPLING_PROFILES = Object.freeze({
  // Choosing a plan, decomposing a mission, deciding what to do next. Needs
  // enough spread to leave a dead end; not enough to forget the contract.
  planning: { temperature: 0.4, top_p: 0.92 },

  // The ordinary agent turn: mostly deciding, sometimes writing.
  agent: { temperature: 0.25, top_p: 0.9 },

  // Emitting file content. Determinism matters more than variety, and a loose
  // sample here is where imaginary APIs come from.
  code: { temperature: 0.1, top_p: 0.85 },

  // Repairing something that just failed. Slightly warmer than `code` on
  // purpose: at temperature 0 a model re-emits the exact text that was already
  // rejected, which is the single most common way a local run stalls.
  repair: { temperature: 0.3, top_p: 0.9 },

  // Pulling structured fields out of text that is already there.
  extraction: { temperature: 0, top_p: 1 },

  // Describing an image. Low, but not zero: at zero a VLM tends to emit the
  // same generic caption regardless of the screenshot.
  vision: { temperature: 0.15, top_p: 0.9 },

  // Summarizing / writing prose for a human.
  summary: { temperature: 0.3, top_p: 0.95 },
});

export const DEFAULT_SAMPLING_PROFILE = "agent";

/**
 * Resolves a profile name (or an explicit override object) into the sampling
 * fields to spread into a chat-completion payload.
 *
 * @param {string|object|null} profile
 * @param {{temperature?:number, top_p?:number}} [overrides] explicit operator settings win
 * @returns {{temperature:number, top_p:number, samplingProfile:string}}
 */
export function resolveSampling(profile, overrides = undefined) {
  const name =
    typeof profile === "string" && SAMPLING_PROFILES[profile]
      ? profile
      : DEFAULT_SAMPLING_PROFILE;
  const base =
    profile && typeof profile === "object" ? profile : SAMPLING_PROFILES[name];
  const temperature = Number.isFinite(overrides?.temperature)
    ? overrides.temperature
    : base.temperature;
  const topP = Number.isFinite(overrides?.top_p) ? overrides.top_p : base.top_p;
  return {
    temperature,
    top_p: topP,
    samplingProfile: typeof profile === "object" ? "custom" : name,
  };
}

export default SAMPLING_PROFILES;
