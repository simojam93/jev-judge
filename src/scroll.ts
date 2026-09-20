import type { JevClient } from "./client.js";
import type { PostJudgment } from "./types.js";

/**
 * Decides whether it's worth fetching another batch of posts, via one Jev `noul` question.
 *
 * The question's state includes `seenCount` plus `lastBatch`'s relevance distribution
 * (`avgRelevance`, `maxRelevance`, `spamRatio`; all 0 for an empty batch) so Jev can weigh
 * diminishing returns. `continue` is true when the noul answer is >= 0.5; `confidence` is
 * the answer's distance from the indifference point (0.5), rescaled to 0..1 — a noul of
 * exactly 0.5 (a coin flip between continuing and stopping) is zero confidence, while a
 * noul of 0 or 1 (maximal certainty either way) is full confidence.
 */
export async function shouldContinueScrolling(
  client: JevClient,
  args: { topic: string; seenCount: number; lastBatch: PostJudgment[] }
): Promise<{ continue: boolean; confidence: number }> {
  const { topic, seenCount, lastBatch } = args;

  const avgRelevance =
    lastBatch.length === 0 ? 0 : lastBatch.reduce((sum, post) => sum + post.relevance, 0) / lastBatch.length;
  const maxRelevance = lastBatch.length === 0 ? 0 : Math.max(...lastBatch.map((post) => post.relevance));
  const spamRatio =
    lastBatch.length === 0 ? 0 : lastBatch.filter((post) => post.isSpam).length / lastBatch.length;

  const response = await client.systemOne({
    state: { topic, seenCount, avgRelevance, maxRelevance, spamRatio },
    questions: {
      keepScrolling: {
        type: "noul",
        instructions: "Given diminishing returns so far, is more scrolling likely to surface valuable posts?",
        criteria: {
          true: "More scrolling is likely to surface additional valuable posts.",
          false: "Returns have diminished enough that further scrolling is unlikely to help.",
        },
      },
    },
  });

  const noulValue = response.answers.keepScrolling?.noul ?? 0;

  return {
    continue: noulValue >= 0.5,
    confidence: Math.abs(noulValue - 0.5) * 2,
  };
}
