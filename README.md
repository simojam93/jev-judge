# jev-judge

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

Calibrated relevance and spam judgments for social posts, powered by [Jev](https://typesafe.ai) (TypeSafe AI's System One model).

## What it is

Most "let an LLM decide" pipelines wrap a chat model in a loop: stuff a rubric into a prompt, ask for JSON back, parse it, retry when the model wanders off-format, and hope the scoring stays consistent across resamples. jev-judge takes a different approach. It asks Jev's System One model calibrated, typed questions — a `score` question over an explicit, ordered rubric for relevance, a `noul` (yes/no-with-probability) question for spam — and gets back numbers with real probabilities and confidence attached, not prose to parse. No JSON-mode gymnastics, no retry-on-malformed-output, no prompt-engineered rubric text that silently drifts between calls.

The library does two things with that primitive: `judgePosts` scores a batch of posts against a topic (0–100 relevance, a spam flag plus its raw probability) in one API call per chunk, and `shouldContinueScrolling` asks a single calibrated question — given what's been seen so far, is fetching more likely to be worth it? — so a feed-scrolling loop can decide to stop itself instead of scrolling forever or guessing at a fixed page count. Everything talks to Jev through one small, injectable client interface (`JevClient`), so both your own code and this library's own test suite can run against a fake with no network call and no API key.

## Install

```sh
npm install jev-judge
```

Set `TYPESAFE_API_KEY` in your environment — see the [TypeSafe docs](https://docs.typesafe.ai/) for how to get one.

## Usage

```ts
import { createJevClient, judgePosts, shouldContinueScrolling } from "jev-judge";

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
// [{ id: "1", relevance: 82, relevanceConfidence: 0.7, isSpam: false, spamScore: 0.05 }, ...]

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
| `judgePosts` | `(client: JevClient, args: { topic: string; posts: PostInput[]; options?: JudgeOptions }) => Promise<PostJudgment[]>` | Chunks `posts` (default 8/call) into one `systemOne` call each: one `score` question (5-level relevance rubric) and one `noul` question (spam) per post. Returns judgments in input order. |
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
  relevance: number;           // 0..100
  relevanceConfidence: number; // 0..1
  isSpam: boolean;
  spamScore: number;           // 0..1, raw Jev noul probability
};
```

**`JudgeOptions`**

```ts
type JudgeOptions = {
  chunkSize?: number;      // posts per systemOne call, default 8
  spamThreshold?: number;  // spamScore at/above which isSpam is true, default 0.6
};
```

## Retries

`createJevClient` wraps every `systemOne` call in its own retry-with-backoff (1s, 2s, 4s) on HTTP 429 (rate limited) and 529 (overloaded) responses. The underlying SDK client is constructed with its own internal retries disabled (`retry: { maxRetries: 0 }`) specifically so the two retry loops don't compound into a much larger worst-case number of HTTP calls than the documented backoff implies.

## Honest limits

- **Chunk sizing** is a starting point, not a tuned answer. `judgePosts` asks 2 questions per post, so a chunk of 8 posts is 16 questions in one `systemOne` call — wider chunks mean fewer calls but a larger prompt per call, and the right trade-off depends on your post length, latency budget, and Jev's per-call pricing. Benchmark against your own data before assuming the default is right for you.
- **Pricing**: Jev bills per `systemOne` call/token, not per post. See [typesafe.ai](https://typesafe.ai) for current pricing before running this over a large backlog.
- This library only knows about plain `{ id, text, author?, metrics? }` posts — it has no opinion on where they came from, and ships with no platform-specific fixtures or fetching logic.

## Development notes

- TypeScript is pinned to `5.9.x`. As of this writing, `tsup@8.5` bundles a `rollup-plugin-dts` build whose declaration-file generation isn't compatible with TypeScript 7's compiler internals; pin back to a 5.x compiler until tsup ships a fix.
- `npm test` runs the full suite against a fake `JevClient` — no network, no API key. `npm run smoke` (see `scripts/smoke.ts`) is the one real-network check: it's skipped automatically when `TYPESAFE_API_KEY` isn't set.

## License

MIT — see [LICENSE](./LICENSE).
