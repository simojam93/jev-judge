import { describe, expect, it, vi } from "vitest";
import type { JevClient, SystemOneRequest, SystemOneResponse } from "./client.js";
import {
  contrastTraits,
  guideUpdatePrompt,
  learnFromChoices,
  parseGuideUpdate,
  readStyleTraits,
  STYLE_TRAITS,
  styleLessons,
  validateTraits,
  type PostTraits,
  type StyleTrait,
} from "./learn.js";

/** kept and dropped posts, each with the value `trait` has for it. */
function sample(trait: string, kept: Record<string, number>, dropped: Record<string, number>) {
  const posts: PostTraits[] = [];
  const choices: Array<{ id: string; kept: boolean; weight?: number }> = [];
  for (const [side, counts] of [["k", kept], ["d", dropped]] as const) {
    for (const [value, n] of Object.entries(counts)) {
      for (let i = 0; i < n; i++) {
        const id = `${side}-${value}-${i}`;
        posts.push({ id, traits: { [trait]: value } });
        choices.push({ id, kept: side === "k" });
      }
    }
  }
  return { posts, choices };
}

describe("validateTraits", () => {
  it("accepts the default traits", () => {
    expect(() => validateTraits(STYLE_TRAITS)).not.toThrow();
  });

  it("rejects a trait it couldn't read", () => {
    const rule: StyleTrait = { id: "t", values: { a: "A", b: "B" }, read: () => "a" };
    expect(() => validateTraits([rule, rule])).toThrow(/twice/);
    expect(() => validateTraits([{ ...rule, id: " " }])).toThrow(/needs an id/);
    expect(() => validateTraits([{ ...rule, values: { a: "A" } }])).toThrow(/two values/);
    expect(() => validateTraits([{ id: "t", values: { a: "A", b: "B" } }])).toThrow(/exactly one/);
    const asked: StyleTrait = { id: "q", values: { a: "A", b: "B" }, question: { instructions: "?", criteria: { a: "x", c: "y" } } };
    expect(() => validateTraits([asked])).toThrow(/doesn't list/);
    expect(() => validateTraits([{ ...asked, question: { instructions: "?", criteria: { a: "x" } } }])).toThrow(/fewer than two/);
    expect(() => validateTraits([{ ...asked, read: () => "a" }])).toThrow(/exactly one/);
  });
});

describe("the default rule traits", () => {
  const read = (id: string, text: string) => STYLE_TRAITS.find((trait) => trait.id === id)!.read!(text);

  it("reads length, numbers, first person and lines without a call", () => {
    expect(read("length", "short one")).toBe("short");
    expect(read("length", "x".repeat(200))).toBe("medium");
    expect(read("length", "x".repeat(241))).toBe("long");
    expect(read("numbers", "Cut build time from 9 to 2 minutes")).toBe("yes");
    expect(read("numbers", "No digits here")).toBe("no");
    expect(read("person", "I shipped it")).toBe("yes");
    expect(read("person", "We're hiring")).toBe("yes");
    expect(read("person", "The team shipped it")).toBe("no");
    expect(read("lines", "one line\n\nand another")).toBe("several");
    expect(read("lines", "  just one  \n")).toBe("one");
  });
});

describe("readStyleTraits", () => {
  it("asks Jev a choice question per trait per post, chunked, and reads the most probable known value", async () => {
    const requests: SystemOneRequest[] = [];
    const client: JevClient = {
      systemOne: vi.fn(async (req: SystemOneRequest): Promise<SystemOneResponse> => {
        requests.push(req);
        const count = (req.state as { posts: unknown[] }).posts.length;
        const answers: SystemOneResponse["answers"] = {};
        for (let i = 0; i < count; i++) {
          answers[`hook_${i}`] = { choice: "claim", probabilities: { number: 0.7, claim: 0.3 } };
          answers[`ending_${i}`] = { choice: "punch" };
          // A value Jev made up doesn't count; the known one left does.
          answers[`tone_${i}`] = { probabilities: { sarcastic: 0.9, plain: 0.1 } };
        }
        if (count === 1) delete answers.tone_0; // no answer: the trait is left out
        return { answers };
      }),
    };
    const long = `I ran 3 tests.\nAll green. ${"x".repeat(3000)}`;
    const read = await readStyleTraits(client, {
      posts: [
        { id: "a", text: "I ran 3 tests.\nAll green." },
        { id: "b", text: "Thoughts on testing" },
        { id: "c", text: long },
      ],
      options: { chunkSize: 2 },
    });

    expect(client.systemOne).toHaveBeenCalledTimes(2);
    expect(Object.keys(requests[0]!.questions)).toEqual(["hook_0", "ending_0", "tone_0", "hook_1", "ending_1", "tone_1"]);
    expect(requests[0]!.questions.hook_1).toEqual({
      type: "choice",
      instructions: "How does post b open, in its first sentence?",
      criteria: STYLE_TRAITS.find((trait) => trait.id === "hook")!.question!.criteria,
    });
    expect(requests[0]!.state).toEqual({ posts: [{ id: "a", text: "I ran 3 tests.\nAll green." }, { id: "b", text: "Thoughts on testing" }] });
    expect((requests[1]!.state as { posts: Array<{ text: string }> }).posts[0]!.text).toHaveLength(2000);

    expect(read).toEqual([
      { id: "a", traits: { length: "short", numbers: "yes", person: "yes", lines: "several", hook: "number", ending: "punch", tone: "plain" } },
      { id: "b", traits: { length: "short", numbers: "no", person: "no", lines: "one", hook: "number", ending: "punch", tone: "plain" } },
      { id: "c", traits: { length: "long", numbers: "yes", person: "yes", lines: "several", hook: "number", ending: "punch" } },
    ]);
  });

  it("keeps input order when chunks come back out of order, and makes no call for rule-only traits", async () => {
    let calls = 0;
    const client: JevClient = {
      systemOne: async (req) => {
        const first = calls++ === 0;
        await new Promise((resolve) => setTimeout(resolve, first ? 20 : 0));
        const id = (req.state as { posts: Array<{ id: string }> }).posts[0]!.id;
        return { answers: { hook_0: { choice: id === "a" ? "question" : "moment" } } };
      },
    };
    const hook = STYLE_TRAITS.filter((trait) => trait.id === "hook");
    const read = await readStyleTraits(client, { posts: [{ id: "a", text: "?" }, { id: "b", text: "!" }], traits: hook, options: { chunkSize: 1 } });
    expect(read.map((post) => post.traits.hook)).toEqual(["question", "moment"]);

    const none = vi.fn();
    const rules = STYLE_TRAITS.filter((trait) => trait.read);
    await readStyleTraits({ systemOne: none }, { posts: [{ id: "a", text: "hi" }], traits: rules });
    expect(none).not.toHaveBeenCalled();
  });

  it("validates the traits before any call", async () => {
    const systemOne = vi.fn();
    await expect(readStyleTraits({ systemOne }, { posts: [{ id: "a", text: "hi" }], traits: [{ id: "t", values: { a: "A" }, read: () => "a" }] })).rejects.toThrow(/two values/);
    expect(systemOne).not.toHaveBeenCalled();
  });
});

describe("contrastTraits", () => {
  it("counts kept and dropped posts per value, with smoothed shares and their lift, strongest first", () => {
    const { posts, choices } = sample("numbers", { yes: 7, no: 3 }, { yes: 1, no: 8 });
    const [first, second] = contrastTraits(posts, choices);
    expect(first).toMatchObject({ trait: "numbers", value: "yes", kept: 7, keptTotal: 10, dropped: 1, droppedTotal: 9 });
    // (7 + 0.5) / (10 + 0.5 × 2) against (1 + 0.5) / (9 + 0.5 × 2)
    expect(first!.keptShare).toBeCloseTo(7.5 / 11, 10);
    expect(first!.droppedShare).toBeCloseTo(0.15, 10);
    expect(first!.lift).toBeCloseTo(7.5 / 11 / 0.15, 10);
    expect(second).toMatchObject({ value: "no", kept: 3, dropped: 8 });
    expect(second!.lift).toBeLessThan(1);
  });

  it("weights move the shares, not the counts", () => {
    const plain = sample("numbers", { yes: 7, no: 3 }, { yes: 1, no: 8 });
    const weighted = { ...plain, choices: plain.choices.map((c) => (c.id.startsWith("k-yes") ? { ...c, weight: 2 } : c)) };
    const before = contrastTraits(plain.posts, plain.choices).find((c) => c.value === "yes")!;
    const after = contrastTraits(weighted.posts, weighted.choices).find((c) => c.value === "yes")!;
    expect(after.kept).toBe(before.kept);
    expect(after.lift).toBeGreaterThan(before.lift);
  });

  it("leaves out values seen in too few posts, traits with only one side, and posts it can't read", () => {
    const { posts, choices } = sample("numbers", { yes: 1, no: 5 }, { yes: 1, no: 5 });
    expect(contrastTraits(posts, choices).map((c) => c.value)).toEqual(["no"]);
    expect(contrastTraits(posts, choices, { minSupport: 1 }).map((c) => c.value).sort()).toEqual(["no", "yes"]);

    const kept = sample("numbers", { yes: 5 }, {});
    expect(contrastTraits(kept.posts, kept.choices)).toEqual([]);

    const unread = sample("numbers", { yes: 4 }, { no: 4 });
    const withStrangers = [...unread.choices, { id: "nobody", kept: false }, { id: unread.choices[0]!.id, kept: true, weight: 0 }];
    expect(contrastTraits(unread.posts, withStrangers).find((c) => c.value === "yes")).toMatchObject({ kept: 4, droppedTotal: 4 });
  });
});

describe("styleLessons", () => {
  it("says the strongest contrast of a trait in words, with the counts", () => {
    const { posts, choices } = sample("numbers", { yes: 7, no: 3 }, { yes: 1, no: 8 });
    expect(styleLessons(contrastTraits(posts, choices))).toEqual([
      { trait: "numbers", value: "yes", direction: "more", lift: expect.any(Number), text: "Has a concrete number: 7 of 10 you kept, 1 of 9 you dropped." },
    ]);
  });

  it("says a two-valued trait as more of what they keep when it can, else as less", () => {
    const flip = sample("numbers", { yes: 9, no: 1 }, { yes: 4, no: 5 });
    // "no" is the stronger contrast (a lift of 0.25), and "yes" (1.9) says the same as a "more".
    expect(styleLessons(contrastTraits(flip.posts, flip.choices))).toMatchObject([
      { value: "yes", direction: "more", text: "Has a concrete number: 9 of 10 you kept, 4 of 9 you dropped." },
    ]);

    const stay = sample("numbers", { yes: 10 }, { yes: 7, no: 2 });
    expect(styleLessons(contrastTraits(stay.posts, stay.choices, { minSupport: 1 }))).toMatchObject([
      { value: "no", direction: "less", text: "Has no numbers: 0 of 10 you kept, 2 of 9 you dropped." },
    ]);
  });

  it("gives a many-valued trait one lesson each way, skips weak ones, and stops at max", () => {
    const { posts, choices } = sample("hook", { number: 5, question: 3, claim: 1, other: 1 }, { question: 2, claim: 6, other: 1 });
    const lessons = styleLessons(contrastTraits(posts, choices));
    expect(lessons.map((lesson) => lesson.text)).toEqual([
      "Opens with a number or a result: 5 of 10 you kept, 0 of 9 you dropped.",
      "Opens with a bold claim: 1 of 10 you kept, 6 of 9 you dropped.",
    ]);
    expect(lessons.map((lesson) => lesson.direction)).toEqual(["more", "less"]);
    expect(styleLessons(contrastTraits(posts, choices), { max: 1 })).toHaveLength(1);
    expect(styleLessons(contrastTraits(posts, choices), { minLift: 50 })).toEqual([]);
  });
});

describe("learnFromChoices", () => {
  it("reads, contrasts and says the lessons in one go", async () => {
    const choices = [
      ...Array.from({ length: 10 }, (_, i) => ({ id: `k${i}`, text: `Shipped ${i + 2} fixes today`, kept: true })),
      ...Array.from({ length: 9 }, (_, i) => ({ id: `d${i}`, text: "Some thoughts on shipping", kept: false })),
    ];
    const client: JevClient = {
      systemOne: async (req) => {
        const posts = (req.state as { posts: Array<{ id: string }> }).posts;
        return { answers: Object.fromEntries(posts.map((post, i) => [`hook_${i}`, { choice: post.id.startsWith("k") ? "number" : "claim" }])) };
      },
    };
    const { traits, lessons } = await learnFromChoices(client, { choices });
    expect(traits).toHaveLength(19);
    expect(lessons.map((lesson) => lesson.text)).toEqual([
      "Has a concrete number: 10 of 10 you kept, 0 of 9 you dropped.",
      "Opens with a bold claim: 0 of 10 you kept, 9 of 9 you dropped.",
      "Opens with a number or a result: 10 of 10 you kept, 0 of 9 you dropped.",
    ]);
  });
});

describe("guideUpdatePrompt", () => {
  const lessons = [
    { trait: "numbers", value: "yes", direction: "more" as const, lift: 4.5, text: "Has a concrete number: 7 of 10 you kept, 1 of 9 you dropped." },
    { trait: "hook", value: "claim", direction: "less" as const, lift: 0.2, text: "Opens with a bold claim: 1 of 10 you kept, 6 of 9 you dropped." },
  ];

  it("briefs the writer with the guide, the lessons, the edits and the examples", () => {
    const prompt = guideUpdatePrompt({ guide: "Short sentences.", lessons, edits: ["shorter", "no emoji"], examples: ["  Shipped 3 fixes.  "] });
    expect(prompt).toContain("Short sentences.");
    expect(prompt).toContain("- Do more: Has a concrete number: 7 of 10 you kept, 1 of 9 you dropped.");
    expect(prompt).toContain("- Do less: Opens with a bold claim: 1 of 10 you kept, 6 of 9 you dropped.");
    expect(prompt).toContain("- shorter\n- no emoji");
    expect(prompt).toContain("---\nShipped 3 fixes.\n---");
    expect(prompt).toContain("never invent a rule");
  });

  it("says so when there's no guide yet or nothing clear", () => {
    const prompt = guideUpdatePrompt({ guide: " ", lessons: [] });
    expect(prompt).toContain("(empty: this will be their first one)");
    expect(prompt).toContain("- Nothing clear yet.");
    expect(prompt).not.toContain("Some posts they kept");
  });
});

describe("parseGuideUpdate", () => {
  it("reads a guide and its changes, trimmed", () => {
    expect(parseGuideUpdate({ guide: " Open with a number. ", changes: [{ summary: " Lead with numbers ", reason: " 7 of 10 kept " }] })).toEqual({
      guide: "Open with a number.",
      changes: [{ summary: "Lead with numbers", reason: "7 of 10 kept" }],
    });
    expect(parseGuideUpdate({ guide: "Same.", changes: [] })).toEqual({ guide: "Same.", changes: [] });
  });

  it("throws on anything else", () => {
    expect(() => parseGuideUpdate(null)).toThrow(/not an object/);
    expect(() => parseGuideUpdate({ guide: " ", changes: [] })).toThrow(/no guide/);
    expect(() => parseGuideUpdate({ guide: "x".repeat(20_001), changes: [] })).toThrow(/no guide/);
    expect(() => parseGuideUpdate({ guide: "g" })).toThrow(/list of changes/);
    expect(() => parseGuideUpdate({ guide: "g", changes: [{ summary: "s" }] })).toThrow(/summary and a reason/);
    expect(() => parseGuideUpdate({ guide: "g", changes: [null] })).toThrow(/summary and a reason/);
  });
});
