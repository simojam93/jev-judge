// scripts/smoke.ts — the one real-network validation for this library.
//
// Run with `npm run smoke`. NOT part of `npm test`: it needs a real TYPESAFE_API_KEY and
// makes a real Jev API call. When the key is absent (e.g. in CI, or a contributor's fresh
// checkout) it prints a SKIPPED line and exits 0, so wiring this into a pipeline is safe.
//
// When the key IS present, it judges 3 hardcoded, generic sample posts (fake handles, no
// real identities) against a fixed topic through the real API, passing a small set of
// hardcoded taste examples (kept/skipped) so tasteFit and the taste-weighted rank are
// actually exercised end to end, and prints each post's raw Jev `score`/`probabilities`
// next to jev-judge's mapped relevance/quality/tasteFit/rank — so a live run visibly
// exercises (and would catch a regression in) the score-normalization and ranking logic in
// src/judge.ts. It then runs checkSlop over one hardcoded obviously-sloppy sample and one
// hardcoded human-sounding sample (again generic, no real identities), printing each one's
// mapped slopScore/verdict/filler fields — exercising the shared normalization logic in
// src/normalize.ts from the other direction.

import {
  checkSlop,
  createJevClient,
  judgePosts,
  sortByRank,
  type JevClient,
  type PostInput,
  type SystemOneRequest,
  type SystemOneResponse,
} from "../src/index.js";

const apiKey = process.env.TYPESAFE_API_KEY;

if (!apiKey) {
  console.log("SKIPPED (no TYPESAFE_API_KEY)");
  process.exit(0);
}

const topic = "AI audio tools";

const posts: PostInput[] = [
  {
    id: "1",
    text: "Just shipped a plugin that auto-tags stems by instrument using a small on-device model. Latency's under 50ms per track.",
    author: "sample_user_1",
  },
  {
    id: "2",
    text: "best AI tool ever!!! you WONT believe this one trick, click my link in bio now!!! 🔥🔥🔥",
    author: "sample_user_2",
  },
  {
    id: "3",
    text: "Neat trick: run source separation locally, then feed the stems into a transcription model for a quick chord chart.",
    author: "sample_user_3",
  },
];

// Generic, hardcoded taste examples (no real identities) so the smoke run exercises the
// taste_i question and tasteFit/rank's 3-way weighting, not just the no-taste 2-way path.
const taste = {
  kept: ["Wrote up a step-by-step on debugging audio latency in a DAW plugin, with real numbers."],
  skipped: ["best deal ever!!! link in bio!!! don't miss out!!!"],
};

// Wrap the real client so we can see each post's raw Jev answer (score/probabilities)
// alongside judgePosts's mapped output, without duplicating judgePosts's own question logic.
const realClient = createJevClient();
const rawResponses: SystemOneResponse[] = [];
const capturingClient: JevClient = {
  async systemOne(req: SystemOneRequest) {
    const response = await realClient.systemOne(req);
    rawResponses.push(response);
    return response;
  },
};

const judgments = await judgePosts(capturingClient, { topic, posts, taste });

// With 3 posts and the default chunk size (8), everything happens in a single systemOne
// call, so rel_<i>/qual_<i>/spam_<i>/taste_<i> in that one response map directly back to
// posts[i].
const [response] = rawResponses;

console.log(`topic: ${topic}`);
console.log();

const columns = [
  "id",
  "raw score",
  "probabilities",
  "relevance",
  "quality",
  "tasteFit",
  "rank",
  "isSpam",
  "spamScore",
];
const rows = judgments.map((judgment, i) => {
  const relAnswer = response?.answers[`rel_${i}`];
  return [
    judgment.id,
    relAnswer?.score !== undefined ? relAnswer.score.toFixed(3) : "n/a",
    relAnswer?.probabilities ? JSON.stringify(relAnswer.probabilities) : "n/a",
    String(judgment.relevance),
    String(judgment.quality),
    judgment.tasteFit !== null ? judgment.tasteFit.toFixed(3) : "n/a",
    String(judgment.rank),
    String(judgment.isSpam),
    judgment.spamScore.toFixed(3),
  ];
});

const widths = columns.map((header, col) => Math.max(header.length, ...rows.map((row) => row[col]!.length)));
const formatRow = (cells: string[]) => cells.map((cell, col) => cell.padEnd(widths[col]!)).join("  ");

console.log(formatRow(columns));
console.log(widths.map((w) => "-".repeat(w)).join("  "));
for (const row of rows) {
  console.log(formatRow(row));
}

console.log();
console.log("sortByRank order:", sortByRank(judgments).map((j) => j.id).join(" > "));

// --- checkSlop smoke: one obviously-sloppy sample and one human-sounding sample, both
// hardcoded and generic (no real identities), same spirit as the judgePosts samples above. ---
const slopSamples: { label: string; text: string }[] = [
  {
    label: "sloppy",
    text: "In today's fast-paced digital landscape, it's more important than ever to stay ahead of the curve! Excited to share this game-changing insight that will transform the way you work. Don't miss out — the future is now!",
  },
  {
    label: "human",
    text: "Spent the weekend chasing a race condition in the stem-separation pipeline — a buffer was getting reused before its async write finished. Obvious in hindsight; took four hours to spot.",
  },
];

console.log();
console.log("checkSlop:");
console.log();

const slopColumns = ["label", "slopScore", "confidence", "verdict", "genericFiller", "fillerScore"];
const slopRows: string[][] = [];
for (const sample of slopSamples) {
  const check = await checkSlop(realClient, { text: sample.text });
  slopRows.push([
    sample.label,
    String(check.slopScore),
    check.confidence.toFixed(3),
    check.verdict,
    String(check.genericFiller),
    check.fillerScore.toFixed(3),
  ]);
}

const slopWidths = slopColumns.map((header, col) =>
  Math.max(header.length, ...slopRows.map((row) => row[col]!.length))
);
const formatSlopRow = (cells: string[]) => cells.map((cell, col) => cell.padEnd(slopWidths[col]!)).join("  ");

console.log(formatSlopRow(slopColumns));
console.log(slopWidths.map((w) => "-".repeat(w)).join("  "));
for (const row of slopRows) {
  console.log(formatSlopRow(row));
}
