import { describe, expect, it, vi } from "vitest";
import type { JevClient, SystemOneRequest, SystemOneResponse } from "./client.js";
import { classifyPosts, kindQuestion, readKind, validateKinds } from "./kinds.js";
import type { PostKind } from "./types.js";

const KINDS: PostKind[] = [
  { label: "story", description: "A first-hand story with numbers.", weight: 1 },
  { label: "news", description: "An announcement or release.", weight: 0.4 },
  { label: "other", description: "None of the above.", weight: 0.1 },
];

describe("validateKinds", () => {
  it("accepts 2 to 12 kinds with unique labels and weights from 0 to 1", () => {
    expect(() => validateKinds(KINDS)).not.toThrow();
  });

  it("rejects too few or too many kinds", () => {
    expect(() => validateKinds([KINDS[0]])).toThrow(/2 to 12/);
    const many = Array.from({ length: 13 }, (_, i) => ({ label: `k${i}`, description: "d", weight: 0.5 }));
    expect(() => validateKinds(many)).toThrow(/2 to 12/);
  });

  it("rejects an empty label, a label used twice, and a weight outside 0..1", () => {
    expect(() => validateKinds([{ ...KINDS[0], label: " " }, KINDS[1]])).toThrow(/non-empty label/);
    expect(() => validateKinds([KINDS[0], { ...KINDS[1], label: "story" }])).toThrow(/twice/);
    expect(() => validateKinds([{ ...KINDS[0], weight: 1.5 }, KINDS[1]])).toThrow(/weight/);
    expect(() => validateKinds([{ ...KINDS[0], weight: Number.NaN }, KINDS[1]])).toThrow(/weight/);
  });
});

describe("kindQuestion", () => {
  it("is a choice question naming the post, with one described label per kind", () => {
    expect(kindQuestion("p7", KINDS)).toEqual({
      type: "choice",
      instructions: "Which kind of post is post p7?",
      criteria: {
        story: "A first-hand story with numbers.",
        news: "An announcement or release.",
        other: "None of the above.",
      },
    });
  });
});

describe("readKind", () => {
  it("picks the most probable label and weighs every label by its probability", () => {
    const read = readKind({ choice: "story", probabilities: { story: 0.7, news: 0.2, other: 0.1 } }, KINDS);
    expect(read.kind).toBe("story");
    // 0.7*1 + 0.2*0.4 + 0.1*0.1 = 0.79
    expect(read.kindFit).toBeCloseTo(0.79, 10);
  });

  it("leaves out labels it doesn't know, renormalizing over the known ones", () => {
    const read = readKind({ probabilities: { story: 0.3, poem: 0.4, news: 0.3 } }, KINDS);
    expect(read.kind).toBe("story");
    // (0.3*1 + 0.3*0.4) / 0.6 = 0.7
    expect(read.kindFit).toBeCloseTo(0.7, 10);
  });

  it("counts the chosen label as certain when there are no probabilities", () => {
    expect(readKind({ choice: "news" }, KINDS)).toEqual({ kind: "news", kindFit: 0.4 });
  });

  it("is null/null for a missing answer or an unknown label", () => {
    expect(readKind(undefined, KINDS)).toEqual({ kind: null, kindFit: null });
    expect(readKind({ choice: "poem" }, KINDS)).toEqual({ kind: null, kindFit: null });
    expect(readKind({ probabilities: { poem: 1 } }, KINDS)).toEqual({ kind: null, kindFit: null });
  });
});

describe("classifyPosts", () => {
  it("returns [] without calling Jev for no posts, and validates kinds first", async () => {
    const systemOne = vi.fn();
    const client: JevClient = { systemOne };
    expect(await classifyPosts(client, { posts: [], kinds: KINDS })).toEqual([]);
    await expect(classifyPosts(client, { posts: [{ id: "a", text: "t" }], kinds: [KINDS[0]] })).rejects.toThrow(/2 to 12/);
    expect(systemOne).not.toHaveBeenCalled();
  });

  it("asks one kind question per post, chunked, and keeps the input order", async () => {
    const calls: SystemOneRequest[] = [];
    const systemOne = vi.fn(async (req: SystemOneRequest): Promise<SystemOneResponse> => {
      calls.push(req);
      const { posts } = req.state as { posts: Array<{ id: string }> };
      return {
        answers: Object.fromEntries(posts.map((p, i) => [`kind_${i}`, { choice: p.id.startsWith("s") ? "story" : "news" }])),
      };
    });
    const posts = ["s1", "n1", "s2"].map((id) => ({ id, text: `text ${id}` }));

    const result = await classifyPosts({ systemOne }, { posts, kinds: KINDS, options: { chunkSize: 2 } });

    expect(systemOne).toHaveBeenCalledTimes(2);
    expect(Object.keys(calls[0].questions)).toEqual(["kind_0", "kind_1"]);
    expect(calls[0].questions.kind_0).toEqual(kindQuestion("s1", KINDS));
    expect(result).toEqual([
      { id: "s1", kind: "story", kindFit: 1 },
      { id: "n1", kind: "news", kindFit: 0.4 },
      { id: "s2", kind: "story", kindFit: 1 },
    ]);
  });
});
