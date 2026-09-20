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
 * Normalizes a Jev `score` answer to the 0..1 range.
 *
 * The installed SDK (`node_modules/@typesafe-ai/sdk/dist/index.d.mts`) documents
 * `ScoreResponse.score` only as "expected score, which may fall between integer rubric
 * levels" — it does not say whether the API already normalizes to 0..1 or returns a
 * probability-weighted index over the rubric's 0-based levels (0..levelCount-1, matching
 * `ScoreLegend`'s 0-based keys). We handle both defensively: a value already within 0..1 is
 * assumed pre-normalized; anything larger is treated as a level index and divided by
 * (levelCount - 1).
 */
export function normalizeScore(raw: number, levelCount: number): number {
  if (raw <= 1) return raw;
  return raw / (levelCount - 1);
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
  posts.forEach((_post, i) => {
    questions[`rel_${i}`] = {
      type: "score",
      instructions: `How relevant and valuable is post ${i} for someone hunting inspiration about the topic?`,
      criteria: RELEVANCE_LEVELS,
    };
    questions[`spam_${i}`] = {
      type: "noul",
      instructions: `Is post ${i} spam, engagement bait, or low-effort filler?`,
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

  if (!relAnswer || !spamAnswer || relAnswer.score === undefined) {
    console.warn(
      `jev-judge: missing Jev answer for post "${post.id}" (index ${index}); defaulting to relevance 0.`
    );
    return { id: post.id, relevance: 0, relevanceConfidence: 0, isSpam: false, spamScore: 0 };
  }

  const normalized = normalizeScore(relAnswer.score, RELEVANCE_LEVELS.length);
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
