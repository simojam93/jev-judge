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
  rank: number; // 0..100, weighted mix of relevance/quality/tasteFit — see JudgeWeights
  isSpam: boolean;
  spamScore: number;
};

/**
 * Recent post texts the caller has seen the user act on: `kept` (saved/kept) versus
 * `skipped` (dismissed). Passed to `judgePosts` to personalize `rank` via `tasteFit`. Each
 * list is capped at 15 items of 400 characters before being sent to Jev — see `judgePosts`.
 */
export type TasteExamples = { kept: string[]; skipped: string[] };

/**
 * Weights for `judgePosts`'s combined `rank`, applied as
 * `rank = relevance*w.relevance + quality*w.quality + (tasteFit*100)*w.taste` (rounded,
 * clamped to 0..100). Must sum to ~1 (±0.01) — `judgePosts` throws otherwise. Defaults (used
 * when `JudgeOptions.weights` is omitted) depend on whether taste examples were supplied:
 * `{ relevance: 0.6, quality: 0.4, taste: 0 }` without them, `{ relevance: 0.45, quality:
 * 0.3, taste: 0.25 }` with them.
 */
export type JudgeWeights = { relevance: number; quality: number; taste: number };

// Note: retries are a concern of the client returned by `createJevClient` (constructed
// separately and passed in), not of `judgePosts` itself, so there is no `maxRetries` here.
export type JudgeOptions = { chunkSize?: number; spamThreshold?: number; weights?: JudgeWeights };
