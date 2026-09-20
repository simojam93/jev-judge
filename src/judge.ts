import type { JevClient, SystemOneAnswer, SystemOneResponse } from "./client.js";
import type { JudgeOptions, PostInput, PostJudgment } from "./types.js";

const RELEVANCE_LEVELS = [
  "off-topic or useless",
  "tangentially related",
  "on-topic but shallow",
  "relevant and substantive",
  "exactly the kind of post worth saving",
] as const;

const DEFAULT_CHUNK_SIZE = 8;
const DEFAULT_SPAM_THRESHOLD = 0.6;

/**
 * Computes relevance as an expected value over Jev's 0-based rubric indices, normalized to
 * 0..1 by dividing by (levelCount - 1).
 *
 * Per the installed SDK's d.ts (`node_modules/@typesafe-ai/sdk/dist/index.d.mts`,
 * `ScoreResponse`): `score` is "Expected score, which may fall between integer rubric
 * levels", and `legend`/`probabilities` are keyed by the rubric's 0-based indices (e.g. "0"
 * through "4" for our 5-level rubric). That is, `score` is always an expectation over those
 * indices — it is NEVER pre-normalized to 0..1. (A previous version of this function
 * guessed otherwise for `raw <= 1` and silently inflated bottom-quartile posts up to 4x;
 * that heuristic has been removed.)
 *
 * When `probabilities` is present we recompute the expectation directly from it
 * (Σ levelIndex * P(levelIndex)) rather than trusting the separately-reported `score`
 * float, so the two can never disagree; otherwise we fall back to `raw / (levelCount - 1)`.
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function chunkPosts(posts: PostInput[], size: number): PostInput[][] {
  const chunks: PostInput[][] = [];
  for (let start = 0; start < posts.length; start += size) {
    chunks.push(posts.slice(start, start + size));
  }
  return chunks;
}

function buildQuestions(posts: PostInput[]): Record<string, unknown> {
  const questions: Record<string, unknown> = {};
  posts.forEach((post, i) => {
    questions[`rel_${i}`] = {
      type: "score",
      instructions: `How relevant and valuable is post ${post.id} for someone hunting inspiration about the topic?`,
      criteria: RELEVANCE_LEVELS,
    };
    questions[`spam_${i}`] = {
      type: "noul",
      instructions: `Is post ${post.id} spam, engagement bait, or low-effort filler?`,
      criteria: {
        true: "The post is spam, engagement bait, or low-effort filler.",
        false: "The post is a genuine, substantive contribution.",
      },
    };
  });
  return questions;
}

function judgmentFor(
  post: PostInput,
  index: number,
  answers: SystemOneResponse["answers"],
  spamThreshold: number
): PostJudgment {
  const relAnswer: SystemOneAnswer | undefined = answers[`rel_${index}`];
  const spamAnswer: SystemOneAnswer | undefined = answers[`spam_${index}`];

  if (
    !relAnswer ||
    !spamAnswer ||
    (relAnswer.score === undefined && !relAnswer.probabilities) ||
    spamAnswer.noul === undefined
  ) {
    console.warn(
      `jev-judge: missing Jev answer for post "${post.id}" (index ${index}); defaulting to relevance 0.`
    );
    return { id: post.id, relevance: 0, relevanceConfidence: 0, isSpam: false, spamScore: 0 };
  }

  const normalized = normalizeScore(relAnswer.score, RELEVANCE_LEVELS.length, relAnswer.probabilities);
  const relevance = clamp(Math.round(normalized * 100), 0, 100);
  const relevanceConfidence = relAnswer.confidence ?? 0;
  const spamScore = spamAnswer.noul ?? 0;
  const isSpam = spamScore >= spamThreshold;

  return { id: post.id, relevance, relevanceConfidence, isSpam, spamScore };
}

/**
 * Judges each post's relevance to `topic` and whether it looks like spam, via Jev.
 *
 * Posts are chunked (default 8 per call, see `options.chunkSize`) into one `systemOne` call
 * each, asking one `score` question (relevance, 5 ordered levels) and one `noul` question
 * (spam) per post. Results are returned in the same order as `posts`.
 */
export async function judgePosts(
  client: JevClient,
  args: { topic: string; posts: PostInput[]; options?: JudgeOptions }
): Promise<PostJudgment[]> {
  const { topic, posts, options } = args;
  if (posts.length === 0) return [];

  const chunkSize = options?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const spamThreshold = options?.spamThreshold ?? DEFAULT_SPAM_THRESHOLD;

  const results: PostJudgment[] = [];
  for (const chunk of chunkPosts(posts, chunkSize)) {
    const response = await client.systemOne({
      state: { topic, posts: chunk },
      questions: buildQuestions(chunk),
    });
    chunk.forEach((post, i) => {
      results.push(judgmentFor(post, i, response.answers, spamThreshold));
    });
  }
  return results;
}
