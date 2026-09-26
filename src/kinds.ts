import type { JevClient, SystemOneAnswer } from "./client.js";
import { clamp } from "./normalize.js";
import type { KindJudgment, PostInput, PostKind } from "./types.js";

const MIN_KINDS = 2;
const MAX_KINDS = 12;
// judgePosts' defaults: one choice question per post is far lighter than judgePosts' three or
// four, but the rate-limit behaviour is the same.
const DEFAULT_CHUNK_SIZE = 8;
const DEFAULT_CONCURRENCY = 4;

/**
 * Throws a clear Error, before any network call, when `kinds` can't make a sound `choice`
 * question: 2 to 12 kinds, each with a non-empty label used once and a weight from 0 to 1.
 */
export function validateKinds(kinds: PostKind[]): void {
  if (kinds.length < MIN_KINDS || kinds.length > MAX_KINDS) {
    throw new Error(`jev-judge: kinds must list ${MIN_KINDS} to ${MAX_KINDS} kinds; got ${kinds.length}`);
  }
  const labels = new Set<string>();
  for (const kind of kinds) {
    if (kind.label.trim().length === 0) throw new Error("jev-judge: every kind needs a non-empty label");
    if (labels.has(kind.label)) throw new Error(`jev-judge: the kind label "${kind.label}" appears twice`);
    labels.add(kind.label);
    if (!Number.isFinite(kind.weight) || kind.weight < 0 || kind.weight > 1) {
      throw new Error(`jev-judge: kind "${kind.label}" has weight ${kind.weight}; weights go from 0 to 1`);
    }
  }
}

/** The `choice` question asking which of `kinds` post `postId` is, each label described. */
export function kindQuestion(postId: string, kinds: PostKind[]): Record<string, unknown> {
  return {
    type: "choice",
    instructions: `Which kind of post is post ${postId}?`,
    criteria: Object.fromEntries(kinds.map((kind) => [kind.label, kind.description])),
  };
}

/**
 * Reads a `choice` answer against `kinds`: the most probable label, and `kindFit` = Σ p(label)
 * × weight(label) over the labels `kinds` knows (probabilities renormalized over those, so a
 * stray label Jev invents neither counts nor dilutes the rest). With no probabilities, the
 * chosen label counts as certain. `{ kind: null, kindFit: null }` when the answer is missing
 * or names no known label.
 */
export function readKind(
  answer: SystemOneAnswer | undefined,
  kinds: PostKind[]
): { kind: string | null; kindFit: number | null } {
  const weightOf = new Map(kinds.map((kind) => [kind.label, kind.weight]));
  const probabilities = answer?.probabilities;
  if (probabilities && Object.keys(probabilities).length > 0) {
    let best: string | null = null;
    let bestP = 0;
    let total = 0;
    let fit = 0;
    for (const [label, p] of Object.entries(probabilities)) {
      const weight = weightOf.get(label);
      if (weight === undefined || !Number.isFinite(p) || p <= 0) continue;
      total += p;
      fit += p * weight;
      if (p > bestP) {
        best = label;
        bestP = p;
      }
    }
    if (best === null) return { kind: null, kindFit: null };
    return { kind: best, kindFit: clamp(fit / total, 0, 1) };
  }
  const chosen = answer?.choice;
  const weight = chosen === undefined ? undefined : weightOf.get(chosen);
  if (chosen === undefined || weight === undefined) return { kind: null, kindFit: null };
  return { kind: chosen, kindFit: weight };
}

/**
 * Tells which of `kinds` each post is — for callers that need only the kind (`judgePosts`
 * asks the same question next to relevance, quality and spam when given `kinds`). One
 * `choice` question per post; posts are chunked (default 8 per `systemOne` call) with up to 4
 * calls in flight, and come back in input order. Validates `kinds` before any call.
 */
export async function classifyPosts(
  client: JevClient,
  args: { posts: PostInput[]; kinds: PostKind[]; options?: { chunkSize?: number; concurrency?: number } }
): Promise<KindJudgment[]> {
  const { posts, kinds, options } = args;
  validateKinds(kinds);
  if (posts.length === 0) return [];

  const size = Math.max(1, Math.floor(options?.chunkSize ?? DEFAULT_CHUNK_SIZE));
  const chunks: PostInput[][] = [];
  for (let start = 0; start < posts.length; start += size) chunks.push(posts.slice(start, start + size));

  const classifyChunk = async (chunk: PostInput[]): Promise<KindJudgment[]> => {
    const questions: Record<string, unknown> = {};
    chunk.forEach((post, i) => {
      questions[`kind_${i}`] = kindQuestion(post.id, kinds);
    });
    const response = await client.systemOne({ state: { posts: chunk }, questions });
    return chunk.map((post, i) => ({ id: post.id, ...readKind(response.answers[`kind_${i}`], kinds) }));
  };

  // The same bounded pool as judgePosts and rateAiStyle: results slotted by chunk index.
  const perChunk: KindJudgment[][] = new Array(chunks.length);
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) {
      const index = next++;
      perChunk[index] = await classifyChunk(chunks[index]);
    }
  };
  const concurrency = Math.max(1, Math.floor(options?.concurrency ?? DEFAULT_CONCURRENCY));
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
  return perChunk.flat();
}
