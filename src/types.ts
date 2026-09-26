export type PostInput = {
  id: string;
  text: string;
  author?: string;
  metrics?: { likes?: number; reposts?: number; replies?: number };
};

export type PostJudgment = {
  id: string;
  relevance: number;
  relevanceConfidence: number;
  quality: number; // 0..100, topic-independent interestingness (always computed)
  qualityConfidence: number; // 0..1
  tasteFit: number | null; // 0..1 raw noul; null when no taste examples were supplied
  rank: number; // 0..100, weighted mix of relevance/quality/tasteFit/kindFit — see JudgeWeights
  isSpam: boolean;
  spamScore: number;
  /** The most probable of the caller's kinds (see `PostKind`). Present only when `judgePosts` got `kinds`; null when Jev gave no kind answer. */
  kind?: string | null;
  /** Σ p(label) × weight(label), 0..1: how much of what the caller wants this post is. Present only when `judgePosts` got `kinds`; null when Jev gave no kind answer. */
  kindFit?: number | null;
};

/**
 * Recent post texts the caller has seen the user act on: `kept` (saved/kept) versus
 * `skipped` (dismissed). Passed to `judgePosts` to personalize `rank` via `tasteFit`. Each
 * list is capped at 15 items of 400 characters before being sent to Jev — see `judgePosts`.
 */
export type TasteExamples = { kept: string[]; skipped: string[] };

/**
 * A kind of post the caller wants told apart — a first-hand story, an opinion, a release — and
 * how much it wants that kind: `weight` from 0 (not at all) to 1 (most). `description` is what
 * Jev reads to recognize it. Pass a catch-all kind too (say "other", weight 0), or every post
 * is forced into one of yours.
 */
export type PostKind = { label: string; description: string; weight: number };

/** `classifyPosts`' answer per post: the same `kind`/`kindFit` pair a `PostJudgment` carries. */
export type KindJudgment = { id: string; kind: string | null; kindFit: number | null };

/**
 * Weights for `judgePosts`'s combined `rank`, applied as `rank = relevance*w.relevance +
 * quality*w.quality + (tasteFit*100)*w.taste + (kindFit*100)*w.kind` (rounded, clamped to
 * 0..100). Must sum to ~1 (±0.01) — `judgePosts` throws otherwise. `kind` is optional (0 when
 * left out). Defaults (used when `JudgeOptions.weights` is omitted), by what was supplied:
 *
 * - no taste, no kinds: relevance 0.6, quality 0.4
 * - taste, no kinds: relevance 0.45, quality 0.3, taste 0.25
 * - kinds, no taste: relevance 0.2, quality 0.35, kind 0.45
 * - kinds and taste: relevance 0.15, quality 0.25, taste 0.25, kind 0.35
 */
export type JudgeWeights = { relevance: number; quality: number; taste: number; kind?: number };

/**
 * `judgePosts`' optional relevance gate: `rank` is multiplied by
 * clamp((relevance − floor) / (full − floor), 0, 1), so a post under `floor` sinks to 0
 * whatever its other signals, and from `full` up relevance no longer holds it back. Needs
 * 0 ≤ floor < full ≤ 100.
 */
export type RelevanceGate = { floor: number; full: number };

// Note: retries are a concern of the client returned by `createJevClient` (constructed
// separately and passed in), not of `judgePosts` itself, so there is no `maxRetries` here.
export type JudgeOptions = {
  chunkSize?: number;
  /** Chunks judged concurrently (default 4 in `judgePosts`); 1 = strictly sequential. */
  concurrency?: number;
  spamThreshold?: number;
  weights?: JudgeWeights;
  relevanceGate?: RelevanceGate;
};
