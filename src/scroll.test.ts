import { describe, expect, it, vi } from "vitest";
import type { JevClient, SystemOneRequest, SystemOneResponse } from "./client.js";
import { shouldContinueScrolling } from "./scroll.js";
import type { PostJudgment } from "./types.js";

function makeJudgment(overrides: Partial<PostJudgment> = {}): PostJudgment {
  return {
    id: "p1",
    relevance: 50,
    relevanceConfidence: 0.5,
    quality: 50,
    qualityConfidence: 0.5,
    tasteFit: null,
    rank: 50,
    isSpam: false,
    spamScore: 0,
    ...overrides,
  };
}

describe("shouldContinueScrolling", () => {
  it("returns continue=true and full confidence when the noul answer is 1", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: { keepScrolling: { noul: 1 } },
    } satisfies SystemOneResponse);
    const client: JevClient = { systemOne };

    const result = await shouldContinueScrolling(client, {
      topic: "cats",
      seenCount: 10,
      lastBatch: [makeJudgment()],
    });

    expect(result).toEqual({ continue: true, confidence: 1 });
  });

  it("returns continue=false and full confidence when the noul answer is 0", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: { keepScrolling: { noul: 0 } },
    } satisfies SystemOneResponse);
    const client: JevClient = { systemOne };

    const result = await shouldContinueScrolling(client, {
      topic: "cats",
      seenCount: 10,
      lastBatch: [makeJudgment()],
    });

    expect(result).toEqual({ continue: false, confidence: 1 });
  });

  it("treats exactly 0.5 as continue=true with zero confidence (a coin flip)", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: { keepScrolling: { noul: 0.5 } },
    } satisfies SystemOneResponse);
    const client: JevClient = { systemOne };

    const result = await shouldContinueScrolling(client, {
      topic: "cats",
      seenCount: 10,
      lastBatch: [makeJudgment()],
    });

    expect(result).toEqual({ continue: true, confidence: 0 });
  });

  it("derives confidence as the distance from 0.5 rescaled to 0..1", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: { keepScrolling: { noul: 0.75 } },
    } satisfies SystemOneResponse);
    const client: JevClient = { systemOne };

    const result = await shouldContinueScrolling(client, {
      topic: "cats",
      seenCount: 10,
      lastBatch: [makeJudgment()],
    });

    // |0.75 - 0.5| * 2 = 0.5
    expect(result).toEqual({ continue: true, confidence: 0.5 });
  });

  it("computes avgRelevance, maxRelevance, and spamRatio from lastBatch in the request state", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: { keepScrolling: { noul: 0.5 } },
    } satisfies SystemOneResponse);
    const client: JevClient = { systemOne };

    const lastBatch = [
      makeJudgment({ id: "a", relevance: 20, isSpam: false }),
      makeJudgment({ id: "b", relevance: 80, isSpam: true }),
    ];

    await shouldContinueScrolling(client, { topic: "cats", seenCount: 42, lastBatch });

    const [request] = systemOne.mock.calls[0] as [SystemOneRequest];
    expect(request.state).toMatchObject({
      topic: "cats",
      seenCount: 42,
      avgRelevance: 50,
      maxRelevance: 80,
      spamRatio: 0.5,
    });
  });

  it("handles an empty lastBatch with avg/max relevance and spamRatio all 0", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: { keepScrolling: { noul: 0.5 } },
    } satisfies SystemOneResponse);
    const client: JevClient = { systemOne };

    await shouldContinueScrolling(client, { topic: "cats", seenCount: 0, lastBatch: [] });

    const [request] = systemOne.mock.calls[0] as [SystemOneRequest];
    expect(request.state).toMatchObject({ avgRelevance: 0, maxRelevance: 0, spamRatio: 0 });
  });

  it("asks exactly one noul question", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: { keepScrolling: { noul: 0.5 } },
    } satisfies SystemOneResponse);
    const client: JevClient = { systemOne };

    await shouldContinueScrolling(client, { topic: "cats", seenCount: 0, lastBatch: [] });

    const [request] = systemOne.mock.calls[0] as [SystemOneRequest];
    const questionEntries = Object.values(request.questions);
    expect(questionEntries).toHaveLength(1);
    expect(questionEntries[0]).toMatchObject({ type: "noul" });
  });
});
