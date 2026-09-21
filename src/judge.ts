import type { JevClient, SystemOneAnswer, SystemOneResponse } from "./client.js";
import { clamp, normalizeScore } from "./normalize.js";
import type { JudgeOptions, JudgeWeights, PostInput, PostJudgment, TasteExamples } from "./types.js";

// Re-exported for backward compatibility: judge.test.ts (and any external consumers) import
// `normalizeScore` from here. The implementation now lives in `./normalize.js`, shared with
// `slop.ts`'s `slopScore` mapping — see that module for the full doc comment on why `score`
// is always an expectation over rubric indices, never pre-normalized to 0..1.
export { normalizeScore };

const RELEVANCE_LEVELS = [
  "off-topic or useless",
  "tangentially related",
  "on-topic but shallow",
  "relevant and substantive",
  "exactly the kind of post worth saving",
] as const;

// Topic-independent: the same post gets the same quality regardless of what it's being
// judged against, unlike RELEVANCE_LEVELS above.
const QUALITY_LEVELS = [
  "empty, generic or clickbait",
  "some substance but forgettable",
  "solid — clear point, some specifics",
  "strong — concrete, novel angle or hard-won insight",
  "exceptional — surprising, specific, quotable",
] as const;

// Default chunk size is unchanged at 8 even though each post now carries 3-4 questions
// (rel/qual/spam, plus taste when taste examples are supplied) instead of 2 — see the
// "Honest limits" section in README.md. Benchmark against your own data before assuming 8
// is right for you.
const DEFAULT_CHUNK_SIZE = 8;
const DEFAULT_SPAM_THRESHOLD = 0.6;

// Defaults for JudgeOptions.weights, picked by whether taste examples were supplied. Kept
// in sync with the doc comment on `judgePosts` and the `JudgeWeights` type — update all
// three together.
const DEFAULT_WEIGHTS_NO_TASTE: JudgeWeights = { relevance: 0.6, quality: 0.4, taste: 0 };
const DEFAULT_WEIGHTS_WITH_TASTE: JudgeWeights = { relevance: 0.45, quality: 0.3, taste: 0.25 };

const WEIGHT_SUM_TOLERANCE = 0.01;

const MAX_TASTE_ITEMS = 15;
const MAX_TASTE_ITEM_CHARS = 400;

function chunkPosts(posts: PostInput[], size: number): PostInput[][] {
  const chunks: PostInput[][] = [];
  for (let start = 0; start < posts.length; start += size) {
    chunks.push(posts.slice(start, start + size));
  }
  return chunks;
}

/** Throws a clear Error when `weights` don't sum to ~1 (within {@link WEIGHT_SUM_TOLERANCE}). */
function validateWeights(weights: JudgeWeights): void {
  const sum = weights.relevance + weights.quality + weights.taste;
  if (Math.abs(sum - 1) > WEIGHT_SUM_TOLERANCE) {
    throw new Error(
      `jev-judge: options.weights must sum to ~1 (±${WEIGHT_SUM_TOLERANCE}); got ` +
        `relevance=${weights.relevance} + quality=${weights.quality} + taste=${weights.taste} = ${sum}`
    );
  }
}

/** Caps a taste example list at {@link MAX_TASTE_ITEMS} items of {@link MAX_TASTE_ITEM_CHARS}
 * characters each, defensively bounding prompt size regardless of what the caller passes. */
function truncateTasteList(items: string[]): string[] {
  return items.slice(0, MAX_TASTE_ITEMS).map((text) => text.slice(0, MAX_TASTE_ITEM_CHARS));
}

function truncateTasteExamples(taste: TasteExamples): TasteExamples {
  return { kept: truncateTasteList(taste.kept), skipped: truncateTasteList(taste.skipped) };
}

function buildQuestions(posts: PostInput[], includeTaste: boolean): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  posts.forEach((post, i) => {
    questions[`rel_${i}`] = {
      type: "score",
      instructions: `How relevant and valuable is post ${post.id} for someone hunting inspiration about the topic?`,
      criteria: RELEVANCE_LEVELS,
    };
    questions[`qual_${i}`] = {
      type: "score",
      instructions: `Independent of the topic, how interesting and substantive is post ${post.id} on its own merits?`,
      criteria: QUALITY_LEVELS,
    };
    questions[`spam_${i}`] = {
      type: "noul",
      instructions: `Is post ${post.id} spam, engagement bait, or low-effort filler?`,
      criteria: {
        true: "The post is spam, engagement bait, or low-effort filler.",
        false: "The post is a genuine, substantive contribution.",
      },
    };
    if (includeTaste) {
      questions[`taste_${i}`] = {
        type: "noul",
        instructions: `Given the examples the user KEPT versus SKIPPED, would the user want to keep post ${post.id}?`,
        criteria: {
          true: "Based on the kept/skipped examples, this post matches what the user tends to keep.",
          false: "Based on the kept/skipped examples, this post matches what the user tends to skip.",
        },
      };
    }
  });
  return questions;
}

/** Combines relevance/quality/tasteFit into `rank` (0..100, rounded). The taste term is
 * dropped (not just zero-weighted) when `tasteFit` is null, so a batch judged without taste
 * examples never silently loses `weights.taste` worth of headroom. */
function computeRank(relevance: number, quality: number, tasteFit: number | null, weights: JudgeWeights): number {
  const tasteTerm = tasteFit === null ? 0 : weights.taste * (tasteFit * 100);
  const raw = weights.relevance * relevance + weights.quality * quality + tasteTerm;
  return clamp(Math.round(raw), 0, 100);
}

function judgmentFor(
  post: PostInput,
  index: number,
  answers: SystemOneResponse["answers"],
  spamThreshold: number,
  includeTaste: boolean,
  weights: JudgeWeights
): PostJudgment {
  const relAnswer: SystemOneAnswer | undefined = answers[`rel_${index}`];
  const qualAnswer: SystemOneAnswer | undefined = answers[`qual_${index}`];
  const spamAnswer: SystemOneAnswer | undefined = answers[`spam_${index}`];
  const tasteAnswer: SystemOneAnswer | undefined = includeTaste ? answers[`taste_${index}`] : undefined;

  const relMissing = !relAnswer || (relAnswer.score === undefined && !relAnswer.probabilities);
  const qualMissing = !qualAnswer || (qualAnswer.score === undefined && !qualAnswer.probabilities);
  const spamMissing = !spamAnswer || spamAnswer.noul === undefined;

  if (relMissing || qualMissing || spamMissing) {
    console.warn(
      `jev-judge: missing Jev answer for post "${post.id}" (index ${index}); defaulting to relevance 0, quality 0.`
    );
    return {
      id: post.id,
      relevance: 0,
      relevanceConfidence: 0,
      quality: 0,
      qualityConfidence: 0,
      tasteFit: null,
      rank: 0,
      isSpam: false,
      spamScore: 0,
    };
  }

  const relNormalized = normalizeScore(relAnswer.score, RELEVANCE_LEVELS.length, relAnswer.probabilities);
  const relevance = clamp(Math.round(relNormalized * 100), 0, 100);
  const relevanceConfidence = relAnswer.confidence ?? 0;

  const qualNormalized = normalizeScore(qualAnswer.score, QUALITY_LEVELS.length, qualAnswer.probabilities);
  const quality = clamp(Math.round(qualNormalized * 100), 0, 100);
  const qualityConfidence = qualAnswer.confidence ?? 0;

  const spamScore = spamAnswer.noul ?? 0;
  const isSpam = spamScore >= spamThreshold;

  // Raw noul, unscaled — unlike relevance/quality this is not remapped to 0..100, per spec.
  const tasteFit = includeTaste ? (tasteAnswer?.noul ?? null) : null;

  const rank = computeRank(relevance, quality, tasteFit, weights);

  return {
    id: post.id,
    relevance,
    relevanceConfidence,
    quality,
    qualityConfidence,
    tasteFit,
    rank,
    isSpam,
    spamScore,
  };
}

/**
 * Judges each post's relevance to `topic`, topic-independent quality, optional fit against
 * the user's taste examples, and whether it looks like spam, via Jev.
 *
 * Posts are chunked (default 8 per call, see `options.chunkSize`) into one `systemOne` call
 * each, asking per post: a `score` question for relevance (5 ordered levels, vs `topic`), a
 * `score` question for quality (5 ordered levels, topic-independent — always asked), and a
 * `noul` question for spam. When `args.taste` is supplied — recent post texts the user
 * `kept` versus `skipped`, each capped at 15 items of 400 characters before being sent — a
 * fourth `noul` question also asks whether the user would want to keep this post, and
 * `taste.kept`/`taste.skipped` are included in the call `state`. So each chunk carries 3
 * questions per post normally, 4 when taste examples are supplied.
 *
 * `rank` (0..100, rounded) combines the three signals as a weighted sum: by default
 * `0.6 * relevance + 0.4 * quality` when no taste examples were supplied, or
 * `0.45 * relevance + 0.3 * quality + 0.25 * (tasteFit * 100)` when they were. Override via
 * `options.weights` (`{ relevance, quality, taste }`, must sum to ~1 within ±0.01 or this
 * throws before any network call).
 *
 * Results are returned in the same order as `posts`.
 */
export async function judgePosts(
  client: JevClient,
  args: { topic: string; posts: PostInput[]; taste?: TasteExamples; options?: JudgeOptions }
): Promise<PostJudgment[]> {
  const { topic, posts, taste, options } = args;

  const includeTaste = taste !== undefined;
  if (options?.weights) validateWeights(options.weights);
  const weights = options?.weights ?? (includeTaste ? DEFAULT_WEIGHTS_WITH_TASTE : DEFAULT_WEIGHTS_NO_TASTE);

  if (posts.length === 0) return [];

  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const spamThreshold = options?.spamThreshold ?? DEFAULT_SPAM_THRESHOLD;
  const truncatedTaste = taste !== undefined ? truncateTasteExamples(taste) : undefined;

  const results: PostJudgment[] = [];
  for (const chunk of chunkPosts(posts, chunkSize)) {
    const state: Record<string, unknown> = { topic, posts: chunk };
    if (truncatedTaste) state.taste = truncatedTaste;

    const response = await client.systemOne({
      state,
      questions: buildQuestions(chunk, includeTaste),
    });
    chunk.forEach((post, i) => {
      results.push(judgmentFor(post, i, response.answers, spamThreshold, includeTaste, weights));
    });
  }
  return results;
}

/**
 * Sorts `judgments` by `rank` descending. Stable: judgments with equal `rank` keep their
 * original relative order. Returns a new array; does not mutate `judgments`.
 */
export function sortByRank(judgments: PostJudgment[]): PostJudgment[] {
  return [...judgments].sort((a, b) => b.rank - a.rank);
}
