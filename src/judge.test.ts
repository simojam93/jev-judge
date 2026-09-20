import { describe, expect, it, vi } from "vitest";
import type { JevClient, SystemOneRequest, SystemOneResponse } from "./client.js";
import { judgePosts, normalizeScore } from "./judge.js";
import type { PostInput } from "./types.js";

function makePost(id: string, text = `text for ${id}`): PostInput {
  return { id, text };
}

describe("normalizeScore", () => {
  it("normalizes a raw score with no probabilities by dividing by (levelCount - 1)", () => {
    // 1 / (5 - 1) = 0.25
    expect(normalizeScore(1, 5)).toBe(0.25);
  });

  it("normalizes another raw score with no probabilities", () => {
    // 0.9 / (5 - 1) = 0.225
    expect(normalizeScore(0.9, 5)).toBeCloseTo(0.225, 10);
  });

  it("computes the expectation from probabilities concentrated on the top level", () => {
    const probabilities = { "0": 0, "1": 0, "2": 0, "3": 0, "4": 1 };
    // expected index = 4 -> 4 / (5 - 1) = 1
    expect(normalizeScore(0, 5, probabilities)).toBe(1);
  });

  it("computes the expectation from probabilities concentrated on the bottom level", () => {
    const probabilities = { "0": 1, "1": 0, "2": 0, "3": 0, "4": 0 };
    // expected index = 0 -> 0 / (5 - 1) = 0
    expect(normalizeScore(4, 5, probabilities)).toBe(0);
  });

  it("prefers probabilities over raw score when both are present and disagree", () => {
    // raw score alone (4 / (5 - 1) = 1) would say "max relevance"; probabilities disagree.
    const probabilities = { "0": 1, "1": 0, "2": 0, "3": 0, "4": 0 };
    expect(normalizeScore(4, 5, probabilities)).toBe(0);
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

  it("maps a raw score with no probabilities via score / (levelCount - 1)", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: {
          rel_0: { score: 0.8, confidence: 0.9 },
          spam_0: { noul: 0.1 },
        },
      } satisfies SystemOneResponse),
    };

    const [judgment] = await judgePosts(client, { topic: "cats", posts: [makePost("p1")] });

    // 0.8 / (5 levels - 1) = 0.2 -> round(20) = 20
    expect(judgment).toEqual({ id: "p1", relevance: 20, relevanceConfidence: 0.9, isSpam: false, spamScore: 0.1 });
  });

  it("maps a raw score of 3 over 5 levels to relevance 75", async () => {
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

  it("computes relevance from probabilities when present, preferring them over raw score", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: {
          // Raw score alone (4 / 4 = 1.0 -> 100) would say max relevance; probabilities,
          // which concentrate all mass on the bottom level, say the opposite.
          rel_0: { score: 4, confidence: 0.5, probabilities: { "0": 1, "1": 0, "2": 0, "3": 0, "4": 0 } },
          spam_0: { noul: 0 },
        },
      } satisfies SystemOneResponse),
    };

    const [judgment] = await judgePosts(client, { topic: "cats", posts: [makePost("p1")] });

    expect(judgment.relevance).toBe(0);
  });

  it("computes relevance 100 from probabilities concentrated on the top level", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: {
          rel_0: { score: 4, confidence: 0.9, probabilities: { "0": 0, "1": 0, "2": 0, "3": 0, "4": 1 } },
          spam_0: { noul: 0 },
        },
      } satisfies SystemOneResponse),
    };

    const [judgment] = await judgePosts(client, { topic: "cats", posts: [makePost("p1")] });

    expect(judgment.relevance).toBe(100);
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

  it("builds the exact spam/relevance instructions text referencing the post id, and the exact 5 relevance levels", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: { rel_0: { score: 0.5, confidence: 1 }, spam_0: { noul: 0 } },
    } satisfies SystemOneResponse);
    const client: JevClient = { systemOne };

    await judgePosts(client, { topic: "cats", posts: [makePost("p1")] });

    const [request] = systemOne.mock.calls[0] as [SystemOneRequest];
    expect(request.questions.spam_0).toMatchObject({
      type: "noul",
      instructions: "Is post p1 spam, engagement bait, or low-effort filler?",
    });
    expect(request.questions.rel_0).toMatchObject({
      type: "score",
      instructions: "How relevant and valuable is post p1 for someone hunting inspiration about the topic?",
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
      // No probabilities in this fixture, so relevance = round((score / (5 levels - 1)) * 100).
      const expectedRelevance = Math.round((rawScoreById.get(`p${i}`)! / 4) * 100);
      expect(judgment.relevance).toBe(expectedRelevance);
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

  it("falls back to relevance 0 / confidence 0 / not spam and warns when a post's answers are entirely missing", async () => {
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

      // 0.9 / (5 levels - 1) = 0.225 -> round(22.5) = 23
      expect(results[0]).toEqual({ id: "p0", relevance: 23, relevanceConfidence: 0.9, isSpam: false, spamScore: 0.1 });
      expect(results[1]).toEqual({ id: "p1", relevance: 0, relevanceConfidence: 0, isSpam: false, spamScore: 0 });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("falls back to relevance 0 / not spam and warns when spamAnswer.noul is undefined", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const systemOne = vi.fn().mockResolvedValue({
        answers: {
          rel_0: { score: 0.9, confidence: 0.9 },
          spam_0: {}, // present, but missing `noul`
        },
      } satisfies SystemOneResponse);
      const client: JevClient = { systemOne };

      const [judgment] = await judgePosts(client, { topic: "cats", posts: [makePost("p1")] });

      expect(judgment).toEqual({ id: "p1", relevance: 0, relevanceConfidence: 0, isSpam: false, spamScore: 0 });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
