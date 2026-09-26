# jev-judge

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Calibrated relevance and spam judgments for social posts, powered by [Jev](https://typesafe.ai) (TypeSafe AI's System One model).

## What it is

Most "let an LLM decide" pipelines wrap a chat model in a loop: stuff a rubric into a prompt, ask for JSON back, parse it, retry when the model wanders off-format, and hope the scoring stays consistent across resamples. jev-judge takes a different approach. It asks Jev's System One model calibrated, typed questions — a `score` question over an explicit, ordered rubric for relevance, a `noul` (yes/no-with-probability) question for spam — and gets back numbers with real probabilities and confidence attached, not prose to parse. No JSON-mode gymnastics, no retry-on-malformed-output, no prompt-engineered rubric text that silently drifts between calls.

The library does two things with that primitive: `judgePosts` scores a batch of posts against a topic — 0–100 relevance, a topic-independent 0–100 quality score, a spam flag plus its raw probability, and (when you pass examples of posts the user kept versus skipped) an optional taste fit — then combines them into a single 0–100 `rank` you can sort by, all in one API call per chunk. `shouldContinueScrolling` asks a single calibrated question — given what's been seen so far, is fetching more likely to be worth it? — so a feed-scrolling loop can decide to stop itself instead of scrolling forever or guessing at a fixed page count. Everything talks to Jev through one small, injectable client interface (`JevClient`), so both your own code and this library's own test suite can run against a fake with no network call and no API key.

## Install

```sh
npm install jev-judge
```

Set `TYPESAFE_API_KEY` in your environment — see the [TypeSafe docs](https://docs.typesafe.ai/) for how to get one.

## Usage

```ts
import { createJevClient, judgePosts, sortByRank, shouldContinueScrolling } from "jev-judge";

const client = createJevClient();

const posts = [
  { id: "1", text: "Just shipped a plugin that auto-tags stems by instrument.", author: "user_a" },
  { id: "2", text: "best tool ever!!! click my link in bio!!! 🔥🔥🔥", author: "user_b" },
  { id: "3", text: "Wrote up how I run local source separation before transcribing chords.", author: "user_c" },
];

const judgments = await judgePosts(client, {
  topic: "home studio audio gear",
  posts,
});
// [{ id: "1", relevance: 82, relevanceConfidence: 0.7, quality: 74, qualityConfidence: 0.6,
//    tasteFit: null, rank: 79, isSpam: false, spamScore: 0.05 }, ...]

const ranked = sortByRank(judgments); // highest rank first; equal ranks keep input order

const { continue: keepScrolling, confidence } = await shouldContinueScrolling(client, {
  topic: "home studio audio gear",
  seenCount: posts.length,
  lastBatch: judgments,
});

console.log(keepScrolling ? "keep scrolling" : "stop here", confidence);
```

## API

| Export | Signature | Notes |
| --- | --- | --- |
| `createJevClient` | `(opts?: { maxRetries?: number; sleep?: (ms: number) => Promise<void> }) => JevClient` | Builds a `JevClient` backed by `@typesafe-ai/sdk`. Wraps every call with retry-with-backoff on HTTP 429/529 (see [Retries](#retries)). `maxRetries` defaults to `3`; `sleep` is injectable (real timers by default). |
| `judgePosts` | `(client: JevClient, args: { topic: string; posts: PostInput[]; taste?: TasteExamples; kinds?: PostKind[]; options?: JudgeOptions }) => Promise<PostJudgment[]>` | Chunks `posts` (default 8/call) into one `systemOne` call each: a `score` question for relevance (5-level rubric, vs `topic`), a `score` question for quality (5-level rubric, topic-independent, always asked), a `noul` question for spam, a `noul` question for taste fit (only when `args.taste` is passed), and a `choice` question for the kind of post (only when `args.kinds` is passed). Combines the signals into `rank` (see [Rank weights](#rank-weights)). Returns judgments in input order. |
| `sortByRank` | `(judgments: PostJudgment[]) => PostJudgment[]` | Sorts by `rank` descending. Stable (equal ranks keep their input order) and non-mutating (returns a new array). |
| `classifyPosts` | `(client: JevClient, args: { posts: PostInput[]; kinds: PostKind[]; options?: { chunkSize?: number; concurrency?: number } }) => Promise<KindJudgment[]>` | One `choice` question per post: which of your kinds it is. See [Rank by the kinds of post you want](#rank-by-the-kinds-of-post-you-want). |
| `shouldContinueScrolling` | `(client: JevClient, args: { topic: string; seenCount: number; lastBatch: PostJudgment[] }) => Promise<{ continue: boolean; confidence: number }>` | One `noul` question over `lastBatch`'s relevance distribution (average/max relevance, spam ratio). `confidence` is the answer's distance from a 50/50 coin flip, rescaled to 0..1. |

**`PostInput`**

```ts
type PostInput = {
  id: string;
  text: string;
  author?: string;
  metrics?: { likes?: number; reposts?: number; replies?: number };
};
```

**`PostJudgment`**

```ts
type PostJudgment = {
  id: string;
  relevance: number;           // 0..100, vs the topic
  relevanceConfidence: number; // 0..1
  quality: number;             // 0..100, topic-independent — always computed
  qualityConfidence: number;   // 0..1
  tasteFit: number | null;     // 0..1 raw probability; null unless `taste` was passed
  rank: number;                // 0..100, weighted mix of the signals above
  isSpam: boolean;
  spamScore: number;           // 0..1, raw Jev noul probability
  kind?: string | null;        // with `kinds`: the most probable label
  kindFit?: number | null;     // with `kinds`: Σ p(label) × weight(label), 0..1
};
```

**`JudgeOptions`**

```ts
type JudgeOptions = {
  chunkSize?: number;      // posts per systemOne call, default 8
  spamThreshold?: number;  // spamScore at/above which isSpam is true, default 0.6
  weights?: JudgeWeights;  // overrides the default rank weights — see Rank weights
  relevanceGate?: { floor: number; full: number }; // rank × clamp((relevance - floor) / (full - floor), 0, 1)
};
```

## Personalizing rank with taste examples

`judgePosts` accepts an optional `taste` argument: recent post texts the user has kept versus skipped, in their own words.

```ts
const judgments = await judgePosts(client, {
  topic: "home studio audio gear",
  posts,
  taste: {
    kept: ["a post the user saved, in its own text", "another one they kept"],
    skipped: ["a post they scrolled past or dismissed"],
  },
});
// tasteFit is now the raw 0..1 probability that the user would want to keep each post, and
// rank folds it in alongside relevance/quality instead of ignoring taste entirely.
```

**`TasteExamples`**

```ts
type TasteExamples = {
  kept: string[];    // recent post texts the user saved or kept
  skipped: string[]; // recent post texts the user dismissed or skipped
};
```

Passing `taste` does three things: it adds a per-post `noul` question asking whether the user would want to keep that post, given what they've kept versus skipped; it includes `taste.kept`/`taste.skipped` in the call's `state` so Jev can weigh the pattern across both lists; and it switches `rank` to the 3-way weights below instead of the 2-way default. Without `taste`, `tasteFit` is always `null` and `rank` only mixes relevance and quality. Each of `kept`/`skipped` is truncated defensively before being sent — capped at the first 15 items, 400 characters each — so pass your most relevant recent examples first.

### Rank weights

`rank` (0..100, rounded) is a weighted mix of the signals above:

| Weight | no `taste` (default) | with `taste` (default) | with `kinds`, no `taste` | with `kinds` and `taste` |
| --- | --- | --- | --- | --- |
| `relevance` | 0.6 | 0.45 | 0.2 | 0.15 |
| `quality` | 0.4 | 0.3 | 0.35 | 0.25 |
| `taste` (× `tasteFit * 100`) | 0 (`tasteFit` is `null`) | 0.25 | 0 | 0.25 |
| `kind` (× `kindFit * 100`) | 0 | 0 | 0.45 | 0.35 |

Override any or all of them via `options.weights`:

```ts
type JudgeWeights = { relevance: number; quality: number; taste: number; kind?: number };
```

They must sum to ~1 (within ±0.01) — `judgePosts` throws a clear `Error` before making any network call otherwise.

## Rank by the kinds of post you want

Relevance says whether a post is on topic. It can't say whether the post is the kind you're
hunting for. Pass `kinds`: your own labels, each described in plain words and weighted from
0 to 1 by how much you want it. `judgePosts` then adds one `choice` question per post:

```ts
const judgments = await judgePosts(client, {
  topic: "indie SaaS",
  posts,
  kinds: [
    { label: "story", description: "A first-hand story with concrete numbers.", weight: 1 },
    { label: "opinion", description: "A strong, arguable opinion.", weight: 0.8 },
    { label: "news", description: "An announcement or a release.", weight: 0.3 },
    { label: "other", description: "None of the above.", weight: 0 },
  ],
  options: { relevanceGate: { floor: 20, full: 50 } },
});
// each judgment also carries kind ("story" | "opinion" | ... | null) and kindFit (0..1)
```

- **`kind` and `kindFit`.** `kind` is the most probable label. `kindFit` is
  Σ p(label) × weight(label), and it joins `rank` with the kind weights above. Include a
  catch-all kind, or every post is forced into one of yours.
- **No kind answer.** When Jev gives no kind for a post, its rank comes from the other
  signals, reweighted. The post is neither rewarded nor penalized.
- **`options.relevanceGate`** is optional and needs 0 ≤ floor < full ≤ 100. It multiplies
  `rank` by clamp((relevance − floor) / (full − floor), 0, 1):
  - a post below `floor` sinks, whatever else it has;
  - from `full` up, relevance stops holding a post back.

  It fits when you rank mostly on kind and quality but want to stay on topic.
- **Without `kinds`, nothing changes.** Judgments carry no `kind` or `kindFit`, and ranks
  are exactly those of 0.1.0.

`classifyPosts(client, { posts, kinds })` asks only the kind question. It returns
`[{ id, kind, kindFit }]` in input order, 8 posts per call.

## Slop check

`checkSlop` is a pre-publish self-check: run a draft through it before it goes out, and it flags text that reads as AI-generated rather than something a specific person wrote. Like `judgePosts` and `shouldContinueScrolling`, it asks Jev calibrated questions instead of parsing prose — a `score` question over a 5-level "human ↔ slop" rubric, and a `noul` question for generic filler — and gets back numbers with real probabilities and confidence attached.

```ts
import { createJevClient, checkSlop } from "jev-judge";

const client = createJevClient();

const check = await checkSlop(client, {
  text: "Thrilled to announce this incredible milestone! Excited for what's next — stay tuned!",
  platform: "linkedin",
});
// { slopScore: 78, confidence: 0.8, verdict: "slop", genericFiller: true, fillerScore: 0.9 }

if (check.verdict !== "human") {
  console.log(`this draft reads as ${check.verdict} (score ${check.slopScore}) — consider a rewrite`);
}
```

`checkSlop(client, args)` — `args.text` is required (throws `Error("text is required")` for empty/whitespace-only text, without calling the client); `args.platform` (`"x" | "linkedin"`, defaults to `"generic"`) is passed through into Jev's state so it can weigh platform-typical conventions; `args.thresholds` overrides either or both of the default verdict cutoffs below.

| `slopScore` | `verdict` |
| --- | --- |
| below 35 | `human` |
| 35 up to (not including) 65 | `borderline` |
| 65 and above | `slop` |

**`SlopCheck`**

```ts
type SlopCheck = {
  slopScore: number;        // 0..100, higher = more AI-slop
  confidence: number;       // 0..1 from the score answer
  verdict: "human" | "borderline" | "slop";
  genericFiller: boolean;   // noul >= 0.5: padded with generic filler phrases
  fillerScore: number;      // raw noul 0..1
};
```

## Retries

`createJevClient` wraps every `systemOne` call in its own retry-with-backoff (1s, 2s, 4s) on HTTP 429 (rate limited) and 529 (overloaded) responses. The underlying SDK client is constructed with its own internal retries disabled (`retry: { maxRetries: 0 }`) specifically so the two retry loops don't compound into a much larger worst-case number of HTTP calls than the documented backoff implies.

## Honest limits

- **Chunk sizing** is a starting point, not a tuned answer. `judgePosts` asks 3 questions per post (relevance, quality, spam), or 4 when you pass `taste` (plus a taste-fit question), so a chunk of 8 posts is 24–32 questions in one `systemOne` call — wider chunks mean fewer calls but a larger prompt per call, and the right trade-off depends on your post length, latency budget, and Jev's per-call pricing. The default chunk size (8) is unchanged from before quality/taste existed; benchmark against your own data before assuming it's right for you.
- **Pricing**: Jev bills per `systemOne` call/token, not per post. See [typesafe.ai](https://typesafe.ai) for current pricing before running this over a large backlog.
- This library only knows about plain `{ id, text, author?, metrics? }` posts — it has no opinion on where they came from, and ships with no platform-specific fixtures or fetching logic.

## Development notes

- TypeScript is pinned to `5.9.x`. As of this writing, `tsup@8.5` bundles a `rollup-plugin-dts` build whose declaration-file generation isn't compatible with TypeScript 7's compiler internals; pin back to a 5.x compiler until tsup ships a fix.
- `npm test` runs the full suite against a fake `JevClient` — no network, no API key. `npm run smoke` (see `scripts/smoke.ts`) is the one real-network check: it's skipped automatically when `TYPESAFE_API_KEY` isn't set.

## License

MIT — see [LICENSE](./LICENSE).
