/**
 * Computes a score-question expectation over Jev's 0-based rubric indices, normalized to
 * 0..1 by dividing by (levelCount - 1).
 *
 * Per the installed SDK's d.ts (`node_modules/@typesafe-ai/sdk/dist/index.d.mts`,
 * `ScoreResponse`): `score` is "Expected score, which may fall between integer rubric
 * levels", and `legend`/`probabilities` are keyed by the rubric's 0-based indices (e.g. "0"
 * through "4" for a 5-level rubric). That is, `score` is always an expectation over those
 * indices — it is NEVER pre-normalized to 0..1.
 *
 * When `probabilities` is present we recompute the expectation directly from it
 * (Σ levelIndex * P(levelIndex)) rather than trusting the separately-reported `score`
 * float, so the two can never disagree; otherwise we fall back to `raw / (levelCount - 1)`.
 *
 * Shared by `judge.ts` (`relevance`) and `slop.ts` (`slopScore`) — both map a Jev `score`
 * question over an ordered rubric to a 0..100 integer via this same expectation, then
 * `clamp(Math.round(normalized * 100), 0, 100)`. Kept in one place so the two never drift.
 */
export function normalizeScore(
  raw: number | undefined,
  levelCount: number,
  probabilities?: Record<string, number>
): number {
  if (probabilities) {
    const expected = Object.entries(probabilities).reduce((sum, [level, p]) => sum + Number(level) * p, 0);
    return expected / (levelCount - 1);
  }
  return (raw ?? 0) / (levelCount - 1);
}

/** Clamps `value` to the inclusive [min, max] range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
