import type { JevClient, SystemOneAnswer } from "./client.js";

/**
 * Learn from what someone keeps. Read a few traits of style from the posts
 * they kept and the ones they dropped, see which traits tell the two apart,
 * and say it in plain lessons ("Has a concrete number: 7 of 10 you kept, 1 of
 * 9 you dropped.") that a writer turns into a style guide change for them to
 * approve. Traits are read locally where a rule can (length, numbers, first
 * person, lines) and asked of Jev where it takes reading (how a post opens,
 * how it ends, its tone). The contrast is plain counting, smoothed so a small
 * sample doesn't shout.
 */

/** A post someone chose: `kept` (picked, starred, did well) or not (dropped, didn't land). `weight` (default 1) counts a strong signal more, a star say. */
export type StyleChoice = { id: string; text: string; kept: boolean; weight?: number };

/**
 * A trait of style: its values, each with the phrase a lesson says it with,
 * read either by a local rule (`read`) or by Jev (`question`: a `choice` over
 * the values, each described; `{id}` in the instructions is the post's id).
 */
export type StyleTrait = {
  id: string;
  values: Record<string, string>;
  read?: (text: string) => string;
  question?: { instructions: string; criteria: Record<string, string> };
};

/** Each post's value for each trait (a Jev trait without a clear answer is left out). */
export type PostTraits = { id: string; traits: Record<string, string> };

/** One trait value across the choices: how many kept and dropped posts have it, and how much likelier it is in the kept ones. */
export type TraitContrast = {
  trait: string;
  value: string;
  /** Kept posts with this value, out of the kept posts whose trait was read. */
  kept: number;
  keptTotal: number;
  /** Dropped posts with this value, out of the dropped posts whose trait was read. */
  dropped: number;
  droppedTotal: number;
  /** Its share among kept and dropped posts, weighted and smoothed. */
  keptShare: number;
  droppedShare: number;
  /** keptShare / droppedShare: above 1, the value shows up more in what they keep. */
  lift: number;
};

/** A plain lesson: do `more` of this, or `less`, with the counts behind it. */
export type StyleLesson = { trait: string; value: string; direction: "more" | "less"; lift: number; text: string };

const FIRST_PERSON = /\b(i|i'm|i've|i'd|i'll|me|my|mine|we|we're|we've|our|ours|us)\b/i;

/** The traits read by default: four by rule, three by Jev. */
export const STYLE_TRAITS: StyleTrait[] = [
  {
    id: "length",
    values: { short: "Short, up to 140 characters", medium: "Medium, 140 to 240 characters", long: "Long, over 240 characters" },
    read: (text) => {
      const length = text.trim().length;
      return length <= 140 ? "short" : length <= 240 ? "medium" : "long";
    },
  },
  {
    id: "numbers",
    values: { yes: "Has a concrete number", no: "Has no numbers" },
    read: (text) => (/\d/.test(text) ? "yes" : "no"),
  },
  {
    id: "person",
    values: { yes: "Written in the first person", no: "Not in the first person" },
    read: (text) => (FIRST_PERSON.test(text) ? "yes" : "no"),
  },
  {
    id: "lines",
    values: { one: "One block of text", several: "Broken into short lines" },
    read: (text) => (text.trim().split(/\n+/).filter((line) => line.trim()).length > 1 ? "several" : "one"),
  },
  {
    id: "hook",
    values: {
      number: "Opens with a number or a result",
      question: "Opens with a question",
      moment: "Opens on a specific moment",
      claim: "Opens with a bold claim",
      other: "Opens another way",
    },
    question: {
      instructions: "How does post {id} open, in its first sentence?",
      criteria: {
        number: "with a number, a result or a metric",
        question: "with a question",
        moment: "on a specific moment or scene, like the start of a story",
        claim: "with a bold or contrarian claim",
        other: "any other way",
      },
    },
  },
  {
    id: "ending",
    values: {
      question: "Ends by asking the reader something",
      ask: "Ends with a call to action",
      punch: "Ends on a punchy line",
      plain: "Just stops, no set-piece ending",
    },
    question: {
      instructions: "How does post {id} end?",
      criteria: {
        question: "it asks the reader a question",
        ask: "it asks the reader to do something: follow, comment, click, try",
        punch: "on a punchy or quotable line",
        plain: "it just stops, with no set-piece ending",
      },
    },
  },
  {
    id: "tone",
    values: { plain: "Plain and conversational", punchy: "Punchy and direct", playful: "Playful", formal: "Formal" },
    question: {
      instructions: "What is the tone of post {id}?",
      criteria: {
        plain: "plain and conversational",
        punchy: "punchy and direct",
        playful: "playful, with some humor",
        formal: "formal or corporate",
      },
    },
  },
];

const DEFAULT_CHUNK_SIZE = 8;
const DEFAULT_CONCURRENCY = 4;
/** A post's style shows in its first couple of thousand characters, like its AI style (see rateAiStyle). */
const MAX_TEXT_CHARS = 2000;
const DEFAULT_SMOOTHING = 0.5;
const DEFAULT_MIN_SUPPORT = 3;
const DEFAULT_MIN_LIFT = 1.5;
const DEFAULT_MAX_LESSONS = 6;

/** Throws before any call when a trait can't be read: a unique id, two values or more, and exactly one of `read` / `question`, asking about its own values. */
export function validateTraits(traits: StyleTrait[]): void {
  const ids = new Set<string>();
  for (const trait of traits) {
    if (!trait.id.trim()) throw new Error("jev-judge: every trait needs an id");
    if (ids.has(trait.id)) throw new Error(`jev-judge: the trait "${trait.id}" appears twice`);
    ids.add(trait.id);
    const values = Object.keys(trait.values);
    if (values.length < 2) throw new Error(`jev-judge: trait "${trait.id}" needs at least two values`);
    if (Boolean(trait.read) === Boolean(trait.question)) throw new Error(`jev-judge: trait "${trait.id}" needs exactly one of read or question`);
    if (trait.question) {
      const asked = Object.keys(trait.question.criteria);
      if (asked.length < 2) throw new Error(`jev-judge: trait "${trait.id}" asks a question with fewer than two answers`);
      if (asked.some((value) => !values.includes(value))) throw new Error(`jev-judge: trait "${trait.id}" asks about a value it doesn't list`);
    }
  }
}

/** The most probable value Jev gave that the trait knows, or null. */
function readChoice(answer: SystemOneAnswer | undefined, values: string[]): string | null {
  const probabilities = answer?.probabilities;
  if (probabilities && Object.keys(probabilities).length > 0) {
    let best: string | null = null;
    let bestP = 0;
    for (const [value, p] of Object.entries(probabilities)) {
      if (values.includes(value) && Number.isFinite(p) && p > bestP) {
        best = value;
        bestP = p;
      }
    }
    return best;
  }
  return answer?.choice !== undefined && values.includes(answer.choice) ? answer.choice : null;
}

/**
 * Reads each trait of each post: rule traits locally, Jev traits as `choice`
 * questions (posts chunked, default 8 per `systemOne` call, up to 4 calls in
 * flight). Comes back in input order. Validates the traits before any call.
 */
export async function readStyleTraits(
  client: JevClient,
  args: { posts: Array<{ id: string; text: string }>; traits?: StyleTrait[]; options?: { chunkSize?: number; concurrency?: number } }
): Promise<PostTraits[]> {
  const traits = args.traits ?? STYLE_TRAITS;
  validateTraits(traits);
  const { posts } = args;
  const byRule = traits.filter((trait) => trait.read);
  const asked = traits.filter((trait) => trait.question);
  const read: PostTraits[] = posts.map((post) => ({
    id: post.id,
    traits: Object.fromEntries(byRule.map((trait) => [trait.id, trait.read!(post.text)])),
  }));
  if (asked.length === 0 || posts.length === 0) return read;

  const size = Math.max(1, Math.floor(args.options?.chunkSize ?? DEFAULT_CHUNK_SIZE));
  const chunks: number[][] = [];
  for (let start = 0; start < posts.length; start += size) {
    chunks.push(Array.from({ length: Math.min(size, posts.length - start) }, (_, i) => start + i));
  }
  const askChunk = async (indexes: number[]) => {
    const questions: Record<string, unknown> = {};
    indexes.forEach((postIndex, i) => {
      for (const trait of asked) {
        questions[`${trait.id}_${i}`] = {
          type: "choice",
          instructions: trait.question!.instructions.replaceAll("{id}", posts[postIndex]!.id),
          criteria: trait.question!.criteria,
        };
      }
    });
    const state = { posts: indexes.map((i) => ({ id: posts[i]!.id, text: posts[i]!.text.slice(0, MAX_TEXT_CHARS) })) };
    const response = await client.systemOne({ state, questions });
    indexes.forEach((postIndex, i) => {
      for (const trait of asked) {
        const value = readChoice(response.answers[`${trait.id}_${i}`], Object.keys(trait.values));
        if (value !== null) read[postIndex]!.traits[trait.id] = value;
      }
    });
  };

  // The same bounded pool as judgePosts and classifyPosts; each chunk writes its own posts' slots.
  let next = 0;
  const worker = async () => {
    while (next < chunks.length) await askChunk(chunks[next++]!);
  };
  const concurrency = Math.max(1, Math.floor(args.options?.concurrency ?? DEFAULT_CONCURRENCY));
  await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, worker));
  return read;
}

/**
 * Which trait values tell kept posts from dropped ones. For each value seen in
 * at least `minSupport` posts (default 3): how many kept and dropped posts
 * have it, and its weighted share on each side, add-`smoothing` smoothed
 * (default 0.5) so a value seen twice doesn't read as a law. A trait with no
 * kept or no dropped posts tells nothing and is left out. Strongest first,
 * either way.
 */
export function contrastTraits(
  posts: PostTraits[],
  choices: Array<Pick<StyleChoice, "id" | "kept" | "weight">>,
  options?: { traits?: StyleTrait[]; smoothing?: number; minSupport?: number }
): TraitContrast[] {
  const traits = options?.traits ?? STYLE_TRAITS;
  const smoothing = options?.smoothing ?? DEFAULT_SMOOTHING;
  const minSupport = options?.minSupport ?? DEFAULT_MIN_SUPPORT;
  const traitsOf = new Map(posts.map((post) => [post.id, post.traits]));
  const out: TraitContrast[] = [];
  for (const trait of traits) {
    const values = Object.keys(trait.values);
    const tally = new Map(values.map((value) => [value, { kept: 0, dropped: 0, keptWeight: 0, droppedWeight: 0 }]));
    let keptTotal = 0;
    let droppedTotal = 0;
    let keptWeight = 0;
    let droppedWeight = 0;
    for (const choice of choices) {
      const weight = choice.weight ?? 1;
      const row = tally.get(traitsOf.get(choice.id)?.[trait.id] ?? "");
      if (!row || !(weight > 0)) continue;
      if (choice.kept) {
        row.kept++;
        row.keptWeight += weight;
        keptTotal++;
        keptWeight += weight;
      } else {
        row.dropped++;
        row.droppedWeight += weight;
        droppedTotal++;
        droppedWeight += weight;
      }
    }
    if (keptTotal === 0 || droppedTotal === 0) continue;
    for (const [value, row] of tally) {
      if (row.kept + row.dropped < minSupport) continue;
      const keptShare = (row.keptWeight + smoothing) / (keptWeight + smoothing * values.length);
      const droppedShare = (row.droppedWeight + smoothing) / (droppedWeight + smoothing * values.length);
      out.push({ trait: trait.id, value, kept: row.kept, keptTotal, dropped: row.dropped, droppedTotal, keptShare, droppedShare, lift: keptShare / droppedShare });
    }
  }
  return out.sort((a, b) => Math.abs(Math.log(b.lift)) - Math.abs(Math.log(a.lift)));
}

/**
 * The contrasts as plain lessons, strongest first: a value at least `minLift`
 * times likelier among kept posts (default 1.5) is "more", as much likelier
 * among dropped ones is "less". A two-valued trait gets one lesson, said as
 * "more" of the value they keep when it can be; a trait with more values can
 * get one each way ("more" questions, "less" bold claims). At most `max`
 * (default 6).
 */
export function styleLessons(
  contrasts: TraitContrast[],
  options?: { traits?: StyleTrait[]; minLift?: number; max?: number }
): StyleLesson[] {
  const traits = new Map((options?.traits ?? STYLE_TRAITS).map((trait) => [trait.id, trait]));
  const minLift = options?.minLift ?? DEFAULT_MIN_LIFT;
  const max = options?.max ?? DEFAULT_MAX_LESSONS;
  const contrastOf = new Map(contrasts.map((c) => [`${c.trait}\u0000${c.value}`, c]));
  const lessons: StyleLesson[] = [];
  const told = new Set<string>();
  for (const found of contrasts) {
    if (lessons.length >= max) break;
    let c = found;
    let direction: StyleLesson["direction"] | null = c.lift >= minLift ? "more" : c.lift <= 1 / minLift ? "less" : null;
    if (!direction) continue;
    const values = Object.keys(traits.get(c.trait)?.values ?? {});
    if (direction === "less" && values.length === 2) {
      // "Has no numbers: less" is "has a concrete number: more", said the way a person keeps it.
      const other = contrastOf.get(`${c.trait}\u0000${values.find((value) => value !== c.value)}`);
      if (other && other.lift >= minLift) {
        c = other;
        direction = "more";
      }
    }
    const key = values.length > 2 ? `${c.trait}\u0000${direction}` : c.trait;
    if (told.has(key)) continue;
    told.add(key);
    const phrase = traits.get(c.trait)?.values[c.value] ?? `${c.trait}: ${c.value}`;
    lessons.push({
      trait: c.trait,
      value: c.value,
      direction,
      lift: c.lift,
      text: `${phrase}: ${c.kept} of ${c.keptTotal} you kept, ${c.dropped} of ${c.droppedTotal} you dropped.`,
    });
  }
  return lessons;
}

/** Reads the choices' traits, contrasts them and says it in lessons, in one go. */
export async function learnFromChoices(
  client: JevClient,
  args: {
    choices: StyleChoice[];
    traits?: StyleTrait[];
    options?: { chunkSize?: number; concurrency?: number; smoothing?: number; minSupport?: number; minLift?: number; maxLessons?: number };
  }
): Promise<{ traits: PostTraits[]; contrasts: TraitContrast[]; lessons: StyleLesson[] }> {
  const traits = args.traits ?? STYLE_TRAITS;
  const o = args.options;
  const read = await readStyleTraits(client, {
    posts: args.choices.map(({ id, text }) => ({ id, text })),
    traits,
    options: { chunkSize: o?.chunkSize, concurrency: o?.concurrency },
  });
  const contrasts = contrastTraits(read, args.choices, { traits, smoothing: o?.smoothing, minSupport: o?.minSupport });
  return { traits: read, contrasts, lessons: styleLessons(contrasts, { traits, minLift: o?.minLift, max: o?.maxLessons }) };
}

// The writer's side. jev-judge doesn't write, but it can brief the writer
// (an LLM of your choice) and check what comes back.

export type GuideChange = { summary: string; reason: string };
export type GuideUpdate = { guide: string; changes: GuideChange[] };

const GUIDE_MAX_CHARS = 20_000;
const MAX_CHANGES = 10;

/** The shape to ask the writer for: a JSON schema fit for structured output (no anyOf). */
export const GUIDE_UPDATE_SCHEMA = {
  type: "object",
  properties: {
    guide: { type: "string", minLength: 1, maxLength: GUIDE_MAX_CHARS },
    changes: {
      type: "array",
      maxItems: MAX_CHANGES,
      items: {
        type: "object",
        properties: {
          summary: { type: "string", minLength: 1, maxLength: 200 },
          reason: { type: "string", minLength: 1, maxLength: 300 },
        },
        required: ["summary", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["guide", "changes"],
  additionalProperties: false,
} as const;

/**
 * Briefs a writer to update a style guide from the lessons and, when given,
 * what the person asked to change in their drafts and a few posts they kept:
 * keep what still holds, change only what the evidence shows, and say each
 * change in one line with its reason.
 */
export function guideUpdatePrompt(args: { guide: string; lessons: StyleLesson[]; edits?: string[]; examples?: string[] }): string {
  const lines = [
    "Here is a writer's style guide for their social posts:",
    args.guide.trim() || "(empty: this will be their first one)",
    "",
    "What their own choices show, from the posts they kept against the ones they dropped:",
    ...(args.lessons.length
      ? args.lessons.map((lesson) => `- ${lesson.direction === "more" ? "Do more" : "Do less"}: ${lesson.text}`)
      : ["- Nothing clear yet."]),
  ];
  if (args.edits?.length) {
    lines.push("", "What they asked to change in their drafts, most recent first:", ...args.edits.map((edit) => `- ${edit}`));
  }
  if (args.examples?.length) {
    lines.push("", "Some posts they kept:", ...args.examples.map((example) => `---\n${example.trim()}`), "---");
  }
  lines.push(
    "",
    "Update the style guide from this evidence. Keep what still holds; add, change or remove only what the evidence supports, and never invent a rule it doesn't show.",
    "Keep the guide about as long as it is, in the same language, as short plain rules the writer can follow.",
    "Then list each change in one line, with its reason citing the evidence. No change is a fine answer: return the guide as it is and an empty list.",
    'Return a JSON object: { "guide": "...", "changes": [ { "summary": "...", "reason": "..." } ] }.',
  );
  return lines.join("\n");
}

/** Checks the writer's answer against {@link GUIDE_UPDATE_SCHEMA}, trimmed; throws a clear Error otherwise. */
export function parseGuideUpdate(value: unknown): GuideUpdate {
  const fail = (why: string): never => {
    throw new Error(`jev-judge: the guide update ${why}`);
  };
  if (typeof value !== "object" || value === null) return fail("is not an object");
  const { guide, changes } = value as { guide?: unknown; changes?: unknown };
  if (typeof guide !== "string" || !guide.trim() || guide.length > GUIDE_MAX_CHARS) return fail("has no guide");
  if (!Array.isArray(changes) || changes.length > MAX_CHANGES) return fail("has no list of changes");
  return {
    guide: guide.trim(),
    changes: changes.map((change) => {
      const { summary, reason } = (change ?? {}) as { summary?: unknown; reason?: unknown };
      if (typeof summary !== "string" || !summary.trim() || typeof reason !== "string" || !reason.trim()) {
        return fail("has a change without a summary and a reason");
      }
      return { summary: summary.trim(), reason: reason.trim() };
    }),
  };
}
