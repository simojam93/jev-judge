import { describe, expect, it, vi } from "vitest";
import type { JevClient, SystemOneAnswer, SystemOneRequest, SystemOneResponse } from "./client.js";
import { judgePosts, normalizeScore, sortByRank } from "./judge.js";
import type { PostInput, PostJudgment } from "./types.js";

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
          qual_0: { score: 2, confidence: 0.6 },
          spam_0: { noul: 0.1 },
        },
      } satisfies SystemOneResponse),
    };

    const [judgment] = await judgePosts(client, { topic: "cats", posts: [makePost("p1")] });

    // relevance: 0.8 / (5 levels - 1) = 0.2 -> round(20) = 20
    // quality: 2 / (5 levels - 1) = 0.5 -> round(50) = 50
    // no taste -> rank = round(0.6*20 + 0.4*50) = round(12 + 20) = 32
    expect(judgment).toEqual({
      id: "p1",
      relevance: 20,
      relevanceConfidence: 0.9,
      quality: 50,
      qualityConfidence: 0.6,
      tasteFit: null,
      rank: 32,
      isSpam: false,
      spamScore: 0.1,
    });
  });

  it("maps a raw score of 3 over 5 levels to relevance 75", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: {
          rel_0: { score: 3, confidence: 0.7 },
          qual_0: { score: 1, confidence: 0.4 },
          spam_0: { noul: 0.2 },
        },
      } satisfies SystemOneResponse),
    };

    const [judgment] = await judgePosts(client, { topic: "cats", posts: [makePost("p1")] });

    // relevance: 3 / (5 levels - 1) = 0.75 -> round(75) = 75
    // quality: 1 / (5 levels - 1) = 0.25 -> round(25) = 25
    // no taste -> rank = round(0.6*75 + 0.4*25) = round(45 + 10) = 55
    expect(judgment).toEqual({
      id: "p1",
      relevance: 75,
      relevanceConfidence: 0.7,
      quality: 25,
      qualityConfidence: 0.4,
      tasteFit: null,
      rank: 55,
      isSpam: false,
      spamScore: 0.2,
    });
  });

  it("computes relevance from probabilities when present, preferring them over raw score", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: {
          // Raw score alone (4 / 4 = 1.0 -> 100) would say max relevance; probabilities,
          // which concentrate all mass on the bottom level, say the opposite.
          rel_0: { score: 4, confidence: 0.5, probabilities: { "0": 1, "1": 0, "2": 0, "3": 0, "4": 0 } },
          qual_0: { score: 2, confidence: 0.5 },
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
          qual_0: { score: 2, confidence: 0.5 },
          spam_0: { noul: 0 },
        },
      } satisfies SystemOneResponse),
    };

    const [judgment] = await judgePosts(client, { topic: "cats", posts: [makePost("p1")] });

    expect(judgment.relevance).toBe(100);
  });

  it("maps quality from a raw score with no probabilities via score / (levelCount - 1), and passes through qualityConfidence", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: {
          rel_0: { score: 0.5, confidence: 1 },
          qual_0: { score: 3, confidence: 0.65 },
          spam_0: { noul: 0 },
        },
      } satisfies SystemOneResponse),
    };

    const [judgment] = await judgePosts(client, { topic: "cats", posts: [makePost("p1")] });

    // 3 / (5 levels - 1) = 0.75 -> round(75) = 75
    expect(judgment.quality).toBe(75);
    expect(judgment.qualityConfidence).toBe(0.65);
  });

  it("computes quality from probabilities when present, preferring them over raw score", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: {
          rel_0: { score: 0.5, confidence: 1 },
          // Raw score alone (4 / 4 = 1.0 -> 100) would say max quality; probabilities,
          // which concentrate all mass on the bottom level, say the opposite.
          qual_0: { score: 4, confidence: 0.5, probabilities: { "0": 1, "1": 0, "2": 0, "3": 0, "4": 0 } },
          spam_0: { noul: 0 },
        },
      } satisfies SystemOneResponse),
    };

    const [judgment] = await judgePosts(client, { topic: "cats", posts: [makePost("p1")] });

    expect(judgment.quality).toBe(0);
  });

  it("flags a post as spam when spamScore meets the default threshold (0.6)", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: {
          rel_0: { score: 0.5, confidence: 1 },
          qual_0: { score: 0.5, confidence: 1 },
          spam_0: { noul: 0.6 },
        },
      } satisfies SystemOneResponse),
    };

    const [judgment] = await judgePosts(client, { topic: "cats", posts: [makePost("p1")] });

    expect(judgment.isSpam).toBe(true);
    expect(judgment.spamScore).toBe(0.6);
  });

  it("does not flag a post as spam just below the default threshold (0.59)", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: {
          rel_0: { score: 0.5, confidence: 1 },
          qual_0: { score: 0.5, confidence: 1 },
          spam_0: { noul: 0.59 },
        },
      } satisfies SystemOneResponse),
    };

    const [judgment] = await judgePosts(client, { topic: "cats", posts: [makePost("p1")] });

    expect(judgment.isSpam).toBe(false);
  });

  it("respects a custom spamThreshold", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: {
          rel_0: { score: 0.5, confidence: 1 },
          qual_0: { score: 0.5, confidence: 1 },
          spam_0: { noul: 0.5 },
        },
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
      answers: {
        rel_0: { score: 0.5, confidence: 1 },
        qual_0: { score: 0.5, confidence: 1 },
        spam_0: { noul: 0 },
      },
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

  it("captures the exact question shapes for rel/qual/spam, and taste when provided (quality levels verbatim)", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: {
        rel_0: { score: 0.5, confidence: 1 },
        qual_0: { score: 0.5, confidence: 1 },
        spam_0: { noul: 0 },
        taste_0: { noul: 0.5 },
      },
    } satisfies SystemOneResponse);
    const client: JevClient = { systemOne };

    await judgePosts(client, {
      topic: "cats",
      posts: [makePost("p1")],
      taste: { kept: ["a great post"], skipped: ["a boring post"] },
    });

    const [request] = systemOne.mock.calls[0] as [SystemOneRequest];

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

    expect(request.questions.qual_0).toMatchObject({
      type: "score",
      criteria: [
        "empty, generic or clickbait",
        "some substance but forgettable",
        "solid — clear point, some specifics",
        "strong — concrete, novel angle or hard-won insight",
        "exceptional — surprising, specific, quotable",
      ],
    });

    expect(request.questions.spam_0).toMatchObject({ type: "noul" });

    expect(request.questions.taste_0).toMatchObject({
      type: "noul",
      instructions: "Given the examples the user KEPT versus SKIPPED, would the user want to keep post p1?",
    });
  });

  it("includes the topic and post fields in the request state", async () => {
    const post = { id: "p1", text: "hello", author: "alice", metrics: { likes: 5 } };
    const systemOne = vi.fn().mockResolvedValue({
      answers: {
        rel_0: { score: 0.5, confidence: 1 },
        qual_0: { score: 0.5, confidence: 1 },
        spam_0: { noul: 0 },
      },
    } satisfies SystemOneResponse);
    const client: JevClient = { systemOne };

    await judgePosts(client, { topic: "cats", posts: [post] });

    expect(systemOne).toHaveBeenCalledWith(
      expect.objectContaining({ state: expect.objectContaining({ topic: "cats", posts: [post] }) })
    );
  });

  it("defaults tasteFit to null and computes rank as 0.6*relevance + 0.4*quality when no taste examples are supplied", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: {
        rel_0: { score: 3, confidence: 0.7 }, // relevance 75
        qual_0: { score: 1, confidence: 0.4 }, // quality 25
        spam_0: { noul: 0 },
      },
    } satisfies SystemOneResponse);
    const client: JevClient = { systemOne };

    const [judgment] = await judgePosts(client, { topic: "cats", posts: [makePost("p1")] });

    expect(judgment.relevance).toBe(75);
    expect(judgment.quality).toBe(25);
    expect(judgment.tasteFit).toBeNull();
    // 0.6*75 + 0.4*25 = 45 + 10 = 55
    expect(judgment.rank).toBe(55);

    const [request] = systemOne.mock.calls[0] as [SystemOneRequest];
    expect(request.questions.taste_0).toBeUndefined();
    expect((request.state as { taste?: unknown }).taste).toBeUndefined();
  });

  it("asks a taste_i question, includes taste.kept/skipped in state, and computes rank with the 3-way weights when taste examples are supplied", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: {
        rel_0: { score: 3, confidence: 0.7 }, // relevance 75
        qual_0: { score: 1, confidence: 0.4 }, // quality 25
        spam_0: { noul: 0 },
        taste_0: { noul: 0.8 },
      },
    } satisfies SystemOneResponse);
    const client: JevClient = { systemOne };

    const taste = { kept: ["kept post text"], skipped: ["skipped post text"] };
    const [judgment] = await judgePosts(client, { topic: "cats", posts: [makePost("p1")], taste });

    // tasteFit is the raw noul, unscaled.
    expect(judgment.tasteFit).toBe(0.8);
    // 0.45*75 + 0.3*25 + 0.25*(0.8*100) = 33.75 + 7.5 + 20 = 61.25 -> round = 61
    expect(judgment.rank).toBe(61);

    const [request] = systemOne.mock.calls[0] as [SystemOneRequest];
    expect(request.questions.taste_0).toMatchObject({
      type: "noul",
      instructions: "Given the examples the user KEPT versus SKIPPED, would the user want to keep post p1?",
    });
    expect((request.state as { taste?: { kept: string[]; skipped: string[] } }).taste).toEqual({
      kept: ["kept post text"],
      skipped: ["skipped post text"],
    });
  });

  it("truncates taste examples to at most 15 items of at most 400 characters each before sending", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: {
        rel_0: { score: 0.5, confidence: 1 },
        qual_0: { score: 0.5, confidence: 1 },
        spam_0: { noul: 0 },
        taste_0: { noul: 0.5 },
      },
    } satisfies SystemOneResponse);
    const client: JevClient = { systemOne };

    const kept = Array.from({ length: 20 }, (_, i) => `kept-${i}`);
    const skipped = Array.from({ length: 18 }, (_, i) => `skipped-${i}`);
    const longText = "x".repeat(500);

    await judgePosts(client, {
      topic: "cats",
      posts: [makePost("p1")],
      taste: { kept: [longText, ...kept], skipped },
    });

    const [request] = systemOne.mock.calls[0] as [SystemOneRequest];
    const taste = (request.state as { taste: { kept: string[]; skipped: string[] } }).taste;

    expect(taste.kept).toHaveLength(15);
    expect(taste.skipped).toHaveLength(15);
    expect(taste.kept[0]).toHaveLength(400);
    expect(taste.kept[0]).toBe("x".repeat(400));
  });

  it("honors custom options.weights over the defaults", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: {
        rel_0: { score: 3, confidence: 0.7 }, // relevance 75
        qual_0: { score: 1, confidence: 0.4 }, // quality 25
        spam_0: { noul: 0 },
        taste_0: { noul: 0.4 },
      },
    } satisfies SystemOneResponse);
    const client: JevClient = { systemOne };

    const [judgment] = await judgePosts(client, {
      topic: "cats",
      posts: [makePost("p1")],
      taste: { kept: ["a"], skipped: ["b"] },
      options: { weights: { relevance: 0.2, quality: 0.2, taste: 0.6 } },
    });

    // 0.2*75 + 0.2*25 + 0.6*(0.4*100) = 15 + 5 + 24 = 44
    expect(judgment.rank).toBe(44);
  });

  it("throws a clear Error when options.weights don't sum to ~1, without calling the client", async () => {
    const systemOne = vi.fn();
    const client: JevClient = { systemOne };

    await expect(
      judgePosts(client, {
        topic: "cats",
        posts: [makePost("p1")],
        options: { weights: { relevance: 0.5, quality: 0.2, taste: 0.1 } }, // sums to 0.8
      })
    ).rejects.toThrow(/weights/i);

    expect(systemOne).not.toHaveBeenCalled();
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
        answers[`qual_${i}`] = { score: rawScoreById.get(post.id), confidence: 1 };
        answers[`spam_${i}`] = { noul: 0 };
      });
      return { answers };
    });
    const client: JevClient = { systemOne };

    const results = await judgePosts(client, { topic: "cats", posts });

    expect(systemOne).toHaveBeenCalledTimes(3);
    expect(calls.map((c) => (c.state as { posts: PostInput[] }).posts.length)).toEqual([8, 8, 1]);
    expect(Object.keys(calls[0]!.questions).sort()).toEqual(
      [0, 1, 2, 3, 4, 5, 6, 7].flatMap((i) => [`rel_${i}`, `qual_${i}`, `spam_${i}`]).sort()
    );
    expect(Object.keys(calls[2]!.questions).sort()).toEqual(["rel_0", "qual_0", "spam_0"].sort());

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
        answers[`qual_${i}`] = { score: 0.5, confidence: 1 };
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
          qual_0: { score: 2, confidence: 0.8 },
          spam_0: { noul: 0.1 },
        },
      } satisfies SystemOneResponse);
      const client: JevClient = { systemOne };

      const results = await judgePosts(client, { topic: "cats", posts });

      // relevance: 0.9 / (5 levels - 1) = 0.225 -> round(22.5) = 23
      // quality: 2 / (5 levels - 1) = 0.5 -> round(50) = 50
      // rank: round(0.6*23 + 0.4*50) = round(13.8 + 20) = round(33.8) = 34
      expect(results[0]).toEqual({
        id: "p0",
        relevance: 23,
        relevanceConfidence: 0.9,
        quality: 50,
        qualityConfidence: 0.8,
        tasteFit: null,
        rank: 34,
        isSpam: false,
        spamScore: 0.1,
      });
      expect(results[1]).toEqual({
        id: "p1",
        relevance: 0,
        relevanceConfidence: 0,
        quality: 0,
        qualityConfidence: 0,
        tasteFit: null,
        rank: 0,
        isSpam: false,
        spamScore: 0,
      });
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
          qual_0: { score: 1, confidence: 0.5 },
          spam_0: {}, // present, but missing `noul`
        },
      } satisfies SystemOneResponse);
      const client: JevClient = { systemOne };

      const [judgment] = await judgePosts(client, { topic: "cats", posts: [makePost("p1")] });

      expect(judgment).toEqual({
        id: "p1",
        relevance: 0,
        relevanceConfidence: 0,
        quality: 0,
        qualityConfidence: 0,
        tasteFit: null,
        rank: 0,
        isSpam: false,
        spamScore: 0,
      });
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("sortByRank", () => {
  function judgmentWithRank(id: string, rank: number): PostJudgment {
    return {
      id,
      relevance: 0,
      relevanceConfidence: 0,
      quality: 0,
      qualityConfidence: 0,
      tasteFit: null,
      rank,
      isSpam: false,
      spamScore: 0,
    };
  }

  it("sorts judgments by rank descending", () => {
    const judgments = [judgmentWithRank("a", 10), judgmentWithRank("b", 90), judgmentWithRank("c", 50)];

    expect(sortByRank(judgments).map((j) => j.id)).toEqual(["b", "c", "a"]);
  });

  it("is stable: judgments with equal rank keep their original relative order", () => {
    const judgments = [
      judgmentWithRank("a", 50),
      judgmentWithRank("b", 90),
      judgmentWithRank("c", 50),
      judgmentWithRank("d", 50),
    ];

    expect(sortByRank(judgments).map((j) => j.id)).toEqual(["b", "a", "c", "d"]);
  });

  it("does not mutate the input array", () => {
    const judgments = [judgmentWithRank("a", 10), judgmentWithRank("b", 90)];
    const original = [...judgments];

    sortByRank(judgments);

    expect(judgments).toEqual(original);
  });

  describe("concurrency", () => {
    function post(id: string) {
      return { id, text: `post ${id}` };
    }
    function postsOf(req: SystemOneRequest): number {
      return (req.state as { posts: unknown[] }).posts.length;
    }
    function answersFor(n: number): SystemOneResponse {
      const answers: Record<string, SystemOneAnswer> = {};
      for (let i = 0; i < n; i++) {
        answers[`rel_${i}`] = { score: 4, probabilities: { "0": 0, "1": 0, "2": 0, "3": 0, "4": 1 } };
        answers[`qual_${i}`] = { score: 4, probabilities: { "0": 0, "1": 0, "2": 0, "3": 0, "4": 1 } };
        answers[`spam_${i}`] = { noul: 0 };
      }
      return { answers };
    }
    const tick = () => new Promise<void>((r) => setTimeout(r, 0));

    it("keeps at most `concurrency` chunks in flight and returns input order even when calls finish out of order", async () => {
      const posts = Array.from({ length: 10 }, (_, i) => post(`p${i}`)); // 5 chunks of 2
      let inFlight = 0;
      let maxInFlight = 0;
      const resolvers: Array<() => void> = [];
      const systemOne = vi.fn(async (req: SystemOneRequest) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise<void>((resolve) => resolvers.push(resolve));
        inFlight--;
        return answersFor(postsOf(req));
      });

      const pending = judgePosts({ systemOne }, { topic: "t", posts, options: { chunkSize: 2, concurrency: 3 } });
      await tick();
      expect(systemOne).toHaveBeenCalledTimes(3); // pool full, two chunks still queued

      // Release in reverse order: ordering must follow chunk index, not completion time.
      resolvers.splice(0).reverse().forEach((r) => r());
      await tick();
      resolvers.splice(0).reverse().forEach((r) => r());
      await tick();
      while (resolvers.length) { resolvers.splice(0).forEach((r) => r()); await tick(); }

      const result = await pending;
      expect(result.map((j) => j.id)).toEqual(posts.map((p) => p.id));
      expect(maxInFlight).toBe(3);
      expect(systemOne).toHaveBeenCalledTimes(5);
    });

    it("concurrency 1 is strictly sequential", async () => {
      const posts = Array.from({ length: 6 }, (_, i) => post(`p${i}`));
      let inFlight = 0;
      let maxInFlight = 0;
      const systemOne = vi.fn(async (req: SystemOneRequest) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await tick();
        inFlight--;
        return answersFor(postsOf(req));
      });
      const result = await judgePosts({ systemOne }, { topic: "t", posts, options: { chunkSize: 2, concurrency: 1 } });
      expect(maxInFlight).toBe(1);
      expect(result).toHaveLength(6);
    });
  });
});
