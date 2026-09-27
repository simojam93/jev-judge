import { describe, expect, it, vi } from "vitest";
import { humanize, HUMANIZE_MAX_ROUNDS, type HumanizeScore } from "./humanize.js";

const scores = (...list: HumanizeScore[]) => {
  const score = vi.fn<(text: string) => Promise<HumanizeScore>>();
  for (const s of list) score.mockResolvedValueOnce(s);
  return score;
};

describe("humanize", () => {
  it("stops as soon as Jev calls a rewrite human", async () => {
    const rewrite = vi.fn(async () => "a loose, human take");
    const out = await humanize({ original: "The original.", rewrite, score: scores({ slopScore: 12, verdict: "human" }) });
    expect(out).toEqual({ text: "a loose, human take", rounds: [{ round: 1, slopScore: 12, verdict: "human" }], score: { slopScore: 12, verdict: "human" } });
    expect(rewrite).toHaveBeenCalledTimes(1);
    expect(rewrite).toHaveBeenCalledWith({ original: "The original.", round: 1, previous: null });
  });

  it("tries again with the last try and its score, and keeps the best of all rounds", async () => {
    const rewrite = vi.fn<(input: { round: number }) => Promise<string>>()
      .mockResolvedValueOnce("try 1").mockResolvedValueOnce("try 2").mockResolvedValueOnce("try 3");
    const out = await humanize({
      original: "o",
      rewrite,
      score: scores({ slopScore: 80, verdict: "slop" }, { slopScore: 40, verdict: "borderline" }, { slopScore: 55, verdict: "borderline" }),
    });
    expect(rewrite).toHaveBeenCalledTimes(HUMANIZE_MAX_ROUNDS);
    expect(rewrite.mock.calls[1]![0]).toEqual({ original: "o", round: 2, previous: { text: "try 1", slopScore: 80, verdict: "slop" } });
    expect(out.text).toBe("try 2");
    expect(out.rounds.map((r) => r.slopScore)).toEqual([80, 40, 55]);
  });

  it("tells each step, and a failing watcher doesn't stop it", async () => {
    const steps: string[] = [];
    await humanize({
      original: "o",
      rewrite: async () => "t",
      score: scores({ slopScore: 70, verdict: "slop" }, { slopScore: 10, verdict: "human" }),
      onStep: (s) => { steps.push(`${s.round}:${s.phase}`); if (s.round === 2) throw new Error("page gone"); },
    });
    expect(steps).toEqual(["1:rewriting", "1:checking", "2:rewriting", "2:checking"]);
  });

  it("degrades: no scorer means one round; a failed check stops; a later failed rewrite keeps the best", async () => {
    expect((await humanize({ original: "o", rewrite: async () => "only" })).rounds).toEqual([{ round: 1, slopScore: null, verdict: null }]);

    const failingCheck = vi.fn(async () => { throw new Error("jev down"); });
    const once = await humanize({ original: "o", rewrite: async () => "t1", score: failingCheck });
    expect(once).toMatchObject({ text: "t1", score: null });

    const rewrite = vi.fn<() => Promise<string>>().mockResolvedValueOnce("t1").mockRejectedValueOnce(new Error("writer down"));
    const kept = await humanize({ original: "o", rewrite, score: scores({ slopScore: 70, verdict: "slop" }) });
    expect(kept.text).toBe("t1");
  });

  it("throws only when the first rewrite fails, or there's no text", async () => {
    await expect(humanize({ original: "o", rewrite: async () => { throw new Error("writer down"); } })).rejects.toThrow("writer down");
    await expect(humanize({ original: "  ", rewrite: async () => "t" })).rejects.toThrow("needs a text");
  });
});
