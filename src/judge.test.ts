import { describe, expect, it, vi } from "vitest";
import type { JevClient, SystemOneRequest, SystemOneResponse } from "./client.js";
import { judgePosts, normalizeScore } from "./judge.js";
import type { PostInput } from "./types.js";

function makePost(id: string, text = `text for ${id}`): PostInput {
  return { id, text };
}

describe("normalizeScore", () => {
  it("treats a raw score already within 0..1 as pre-normalized", () => {
    expect(normalizeScore(0.4, 5)).toBe(0.4);
  });

  it("treats a raw score greater than 1 as a level-weighted index over (levelCount - 1)", () => {
    expect(normalizeScore(2, 5)).toBe(0.5); // 2 / (5 - 1)
  });
});

describe("judgePosts", () => {
  it("returns [] and makes no calls for an empty post list", async () => {
    const systemOne = vi.fn();
    const client: JevClient = { systemOne };

    const result = await judgePosts(client, { topic: "cats", posts: [] });

    expect(result).toEqual([]);
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("maps an already-normalized score (<=1) and a low spam noul", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: {
          rel_0: { score: 0.8, confidence: 0.9 },
          spam_0: { noul: 0.1 },
        },
      } satisfies SystemOneResponse),
    };

    const [judgment] = await judgePosts(client, { topic: "cats", posts: [makePost("p1")] });

    expect(judgment).toEqual({ id: "p1", relevance: 80, relevanceConfidence: 0.9, isSpam: false, spamScore: 0.1 });
  });

  it("maps an unnormalized level-weighted score (>1, over 5 levels) to 0..100", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: {
          rel_0: { score: 3, confidence: 0.7 },
          spam_0: { noul: 0.2 },
        },
      } satisfies SystemOneResponse),
    };

    const [judgment] = await judgePosts(client, { topic: "cats", posts: [makePost("p1")] });

    // 3 / (5 levels - 1) = 0.75 -> round(75) = 75
    expect(judgment).toEqual({ id: "p1", relevance: 75, relevanceConfidence: 0.7, isSpam: false, spamScore: 0.2 });
  });

  it("flags a post as spam when spamScore meets the default threshold (0.6)", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: { rel_0: { score: 0.5, confidence: 1 }, spam_0: { noul: 0.6 } },
      } satisfies SystemOneResponse),
    };

    const [judgment] = await judgePosts(client, { topic: "cats", posts: [makePost("p1")] });

    expect(judgment.isSpam).toBe(true);
    expect(judgment.spamScore).toBe(0.6);
  });

  it("does not flag a post as spam just below the default threshold (0.59)", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: { rel_0: { score: 0.5, confidence: 1 }, spam_0: { noul: 0.59 } },
      } satisfies SystemOneResponse),
    };

    const [judgment] = await judgePosts(client, { topic: "cats", posts: [makePost("p1")] });

    expect(judgment.isSpam).toBe(false);
  });

  it("respects a custom spamThreshold", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: { rel_0: { score: 0.5, confidence: 1 }, spam_0: { noul: 0.5 } },
      } satisfies SystemOneResponse),
    };

    const [judgment] = await judgePosts(client, {
      topic: "cats",
      posts: [makePost("p1")],
      options: { spamThreshold: 0.4 },
    });

    expect(judgment.isSpam).toBe(true);
  });

  it("builds the exact spam instructions text and the exact 5 relevance levels", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: { rel_0: { score: 0.5, confidence: 1 }, spam_0: { noul: 0 } },
    } satisfies SystemOneResponse);
    const client: JevClient = { systemOne };

    await judgePosts(client, { topic: "cats", posts: [makePost("p1")] });

    const [request] = systemOne.mock.calls[0] as [SystemOneRequest];
    expect(request.questions.spam_0).toMatchObject({
      type: "noul",
      instructions: "Is post 0 spam, engagement bait, or low-effort filler?",
    });
    expect(request.questions.rel_0).toMatchObject({
      type: "score",
      criteria: [
        "off-topic or useless",
        "tangentially related",
        "on-topic but shallow",
        "relevant and substantive",
        "exactly the kind of post worth saving",
      ],
    });
  });

  it("includes the topic and post fields in the request state", async () => {
    const post = { id: "p1", text: "hello", author: "alice", metrics: { likes: 5 } };
    const systemOne = vi.fn().mockResolvedValue({
      answers: { rel_0: { score: 0.5, confidence: 1 }, spam_0: { noul: 0 } },
    } satisfies SystemOneResponse);
    const client: JevClient = { systemOne };

    await judgePosts(client, { topic: "cats", posts: [post] });

    expect(systemOne).toHaveBeenCalledWith(
      expect.objectContaining({ state: expect.objectContaining({ topic: "cats", posts: [post] }) })
    );
  });

  it("chunks 17 posts into 3 calls (8/8/1), builds correct question keys per chunk, and preserves order", async () => {
    const posts = Array.from({ length: 17 }, (_, i) => makePost(`p${i}`));
    // Distinct raw score per post id so a cross-chunk index mixup would be caught.
    const rawScoreById = new Map(posts.map((p, i) => [p.id, i / 100]));

    const calls: SystemOneRequest[] = [];
    const systemOne = vi.fn(async (req: SystemOneRequest): Promise<SystemOneResponse> => {
      calls.push(req);
      const { posts: chunkPosts } = req.state as { posts: PostInput[] };
      const answers: SystemOneResponse["answers"] = {};
      chunkPosts.forEach((post, i) => {
        answers[`rel_${i}`] = { score: rawScoreById.get(post.id), confidence: 1 };
        answers[`spam_${i}`] = { noul: 0 };
      });
      return { answers };
    });
    const client: JevClient = { systemOne };

    const results = await judgePosts(client, { topic: "cats", posts });

    expect(systemOne).toHaveBeenCalledTimes(3);
    expect(calls.map((c) => (c.state as { posts: PostInput[] }).posts.length)).toEqual([8, 8, 1]);
    expect(Object.keys(calls[0]!.questions).sort()).toEqual(
      [0, 1, 2, 3, 4, 5, 6, 7].flatMap((i) => [`rel_${i}`, `spam_${i}`]).sort()
    );
    expect(Object.keys(calls[2]!.questions).sort()).toEqual(["rel_0", "spam_0"]);

    expect(results).toHaveLength(17);
    results.forEach((judgment, i) => {
      expect(judgment.id).toBe(`p${i}`);
      expect(judgment.relevance).toBe(Math.round((i / 100) * 100));
    });
  });

  it("uses a custom chunkSize", async () => {
    const posts = Array.from({ length: 5 }, (_, i) => makePost(`p${i}`));
    const systemOne = vi.fn(async (req: SystemOneRequest): Promise<SystemOneResponse> => {
      const { posts: chunkPosts } = req.state as { posts: PostInput[] };
      const answers: SystemOneResponse["answers"] = {};
      chunkPosts.forEach((_post, i) => {
        answers[`rel_${i}`] = { score: 0.5, confidence: 1 };
        answers[`spam_${i}`] = { noul: 0 };
      });
      return { answers };
    });
    const client: JevClient = { systemOne };

    await judgePosts(client, { topic: "cats", posts, options: { chunkSize: 2 } });

    expect(systemOne).toHaveBeenCalledTimes(3); // 2 + 2 + 1
  });

  it("falls back to relevance 0 / confidence 0 / not spam and warns when a post's answers are missing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const posts = [makePost("p0"), makePost("p1")];
      const systemOne = vi.fn().mockResolvedValue({
        answers: {
          // p0 (index 0) answered normally; p1 (index 1) has no answers at all.
          rel_0: { score: 0.9, confidence: 0.9 },
          spam_0: { noul: 0.1 },
        },
      } satisfies SystemOneResponse);
      const client: JevClient = { systemOne };

      const results = await judgePosts(client, { topic: "cats", posts });

      expect(results[0]).toEqual({ id: "p0", relevance: 90, relevanceConfidence: 0.9, isSpam: false, spamScore: 0.1 });
      expect(results[1]).toEqual({ id: "p1", relevance: 0, relevanceConfidence: 0, isSpam: false, spamScore: 0 });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
