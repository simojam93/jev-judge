import { describe, expect, it, vi } from "vitest";
import type { JevClient, SystemOneRequest, SystemOneResponse } from "./client.js";
import { checkSlop } from "./slop.js";

describe("checkSlop", () => {
  it("throws a clear error for empty text without calling the client", async () => {
    const systemOne = vi.fn();
    const client: JevClient = { systemOne };

    await expect(checkSlop(client, { text: "" })).rejects.toThrow("text is required");
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("throws for whitespace-only text without calling the client", async () => {
    const systemOne = vi.fn();
    const client: JevClient = { systemOne };

    await expect(checkSlop(client, { text: "   " })).rejects.toThrow("text is required");
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("maps a raw score with no probabilities via score / (levelCount - 1)", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: {
          slop: { score: 2, confidence: 0.8 },
          filler: { noul: 0.1 },
        },
      } satisfies SystemOneResponse),
    };

    const result = await checkSlop(client, { text: "some draft text" });

    // 2 / (5 levels - 1) = 0.5 -> round(50) = 50
    expect(result.slopScore).toBe(50);
    expect(result.confidence).toBe(0.8);
    expect(result.verdict).toBe("borderline");
    expect(result.fillerScore).toBe(0.1);
    expect(result.genericFiller).toBe(false);
  });

  it("computes slopScore from probabilities when present, preferring them over raw score", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: {
          // Raw score alone (4 / 4 = 1.0 -> 100) would say "obvious AI slop"; probabilities,
          // which concentrate all mass on the bottom level, say the opposite.
          slop: { score: 4, confidence: 0.5, probabilities: { "0": 1, "1": 0, "2": 0, "3": 0, "4": 0 } },
          filler: { noul: 0 },
        },
      } satisfies SystemOneResponse),
    };

    const result = await checkSlop(client, { text: "some draft text" });

    expect(result.slopScore).toBe(0);
    expect(result.verdict).toBe("human");
  });

  it("classifies slopScore 34 as human (just below the borderline threshold)", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: {
          // expected = 1*0.64 + 2*0.36 = 1.36 -> /4 = 0.34 -> slopScore 34
          slop: { confidence: 0.5, probabilities: { "0": 0, "1": 0.64, "2": 0.36, "3": 0, "4": 0 } },
          filler: { noul: 0 },
        },
      } satisfies SystemOneResponse),
    };

    const result = await checkSlop(client, { text: "some draft text" });

    expect(result.slopScore).toBe(34);
    expect(result.verdict).toBe("human");
  });

  it("classifies slopScore 35 as borderline (at the borderline threshold)", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: {
          // expected = 1*0.6 + 2*0.4 = 1.4 -> /4 = 0.35 -> slopScore 35
          slop: { confidence: 0.5, probabilities: { "0": 0, "1": 0.6, "2": 0.4, "3": 0, "4": 0 } },
          filler: { noul: 0 },
        },
      } satisfies SystemOneResponse),
    };

    const result = await checkSlop(client, { text: "some draft text" });

    expect(result.slopScore).toBe(35);
    expect(result.verdict).toBe("borderline");
  });

  it("classifies slopScore 64 as borderline (just below the slop threshold)", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: {
          // expected = 2*0.44 + 3*0.56 = 2.56 -> /4 = 0.64 -> slopScore 64
          slop: { confidence: 0.5, probabilities: { "0": 0, "1": 0, "2": 0.44, "3": 0.56, "4": 0 } },
          filler: { noul: 0 },
        },
      } satisfies SystemOneResponse),
    };

    const result = await checkSlop(client, { text: "some draft text" });

    expect(result.slopScore).toBe(64);
    expect(result.verdict).toBe("borderline");
  });

  it("classifies slopScore 65 as slop (at the slop threshold)", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: {
          // expected = 2*0.4 + 3*0.6 = 2.6 -> /4 = 0.65 -> slopScore 65
          slop: { confidence: 0.5, probabilities: { "0": 0, "1": 0, "2": 0.4, "3": 0.6, "4": 0 } },
          filler: { noul: 0 },
        },
      } satisfies SystemOneResponse),
    };

    const result = await checkSlop(client, { text: "some draft text" });

    expect(result.slopScore).toBe(65);
    expect(result.verdict).toBe("slop");
  });

  it("respects custom thresholds, defaulting the one not overridden", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: {
          // expected = 2*0.2 + 3*0.8 = 2.8 -> /4 = 0.7 -> slopScore 70
          slop: { confidence: 0.5, probabilities: { "0": 0, "1": 0, "2": 0.2, "3": 0.8, "4": 0 } },
          filler: { noul: 0 },
        },
      } satisfies SystemOneResponse),
    };

    // Under the default thresholds (35/65), slopScore 70 would be "slop". Overriding just
    // `slop` to 75 should reclassify it as "borderline", while `borderline` still falls back
    // to its default of 35.
    const result = await checkSlop(client, {
      text: "some draft text",
      thresholds: { slop: 75 },
    });

    expect(result.slopScore).toBe(70);
    expect(result.verdict).toBe("borderline");
  });

  it("does not flag genericFiller just below the 0.5 threshold", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: {
          slop: { score: 0, confidence: 1 },
          filler: { noul: 0.49 },
        },
      } satisfies SystemOneResponse),
    };

    const result = await checkSlop(client, { text: "some draft text" });

    expect(result.fillerScore).toBe(0.49);
    expect(result.genericFiller).toBe(false);
  });

  it("flags genericFiller at exactly the 0.5 threshold", async () => {
    const client: JevClient = {
      systemOne: vi.fn().mockResolvedValue({
        answers: {
          slop: { score: 0, confidence: 1 },
          filler: { noul: 0.5 },
        },
      } satisfies SystemOneResponse),
    };

    const result = await checkSlop(client, { text: "some draft text" });

    expect(result.fillerScore).toBe(0.5);
    expect(result.genericFiller).toBe(true);
  });

  it("passes the given platform into the request state", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: { slop: { score: 0, confidence: 1 }, filler: { noul: 0 } },
    } satisfies SystemOneResponse);
    const client: JevClient = { systemOne };

    await checkSlop(client, { text: "some draft text", platform: "linkedin" });

    const [request] = systemOne.mock.calls[0] as [SystemOneRequest];
    expect(request.state).toMatchObject({ platform: "linkedin", text: "some draft text" });
  });

  it("defaults platform to 'generic' in the request state when not provided", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: { slop: { score: 0, confidence: 1 }, filler: { noul: 0 } },
    } satisfies SystemOneResponse);
    const client: JevClient = { systemOne };

    await checkSlop(client, { text: "some draft text" });

    const [request] = systemOne.mock.calls[0] as [SystemOneRequest];
    expect(request.state).toMatchObject({ platform: "generic", text: "some draft text" });
  });

  it("builds the exact slop/filler question shapes, with the 5 slop levels verbatim", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: { slop: { score: 0, confidence: 1 }, filler: { noul: 0 } },
    } satisfies SystemOneResponse);
    const client: JevClient = { systemOne };

    await checkSlop(client, { text: "some draft text" });

    const [request] = systemOne.mock.calls[0] as [SystemOneRequest];
    expect(request.questions.filler).toMatchObject({
      type: "noul",
      instructions: "Is this text padded with generic filler phrases, hollow engagement hooks, or AI-typical boilerplate?",
    });
    expect(request.questions.slop).toMatchObject({
      type: "score",
      criteria: [
        "reads like a specific human wrote it — concrete, opinionated, lived-in",
        "mostly human — a few stock phrases",
        "mixed — noticeable templated patterns",
        "largely generic — AI-typical structure and hedging",
        "obvious AI slop — hollow, padded, interchangeable",
      ],
    });
  });

  it("asks exactly the slop and filler questions (no extras)", async () => {
    const systemOne = vi.fn().mockResolvedValue({
      answers: { slop: { score: 0, confidence: 1 }, filler: { noul: 0 } },
    } satisfies SystemOneResponse);
    const client: JevClient = { systemOne };

    await checkSlop(client, { text: "some draft text" });

    const [request] = systemOne.mock.calls[0] as [SystemOneRequest];
    expect(Object.keys(request.questions).sort()).toEqual(["filler", "slop"]);
  });
});
