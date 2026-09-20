// scripts/smoke.ts — the one real-network validation for this library.
//
// Run with `npm run smoke`. NOT part of `npm test`: it needs a real TYPESAFE_API_KEY and
// makes a real Jev API call. When the key is absent (e.g. in CI, or a contributor's fresh
// checkout) it prints a SKIPPED line and exits 0, so wiring this into a pipeline is safe.
//
// When the key IS present, it judges 3 hardcoded, generic sample posts (fake handles, no
// real identities) against a fixed topic through the real API, and prints each post's raw
// Jev `score`/`probabilities` next to jev-judge's mapped `relevance` — so a live run
// visibly exercises (and would catch a regression in) the score-normalization logic in
// src/judge.ts.

import {
  createJevClient,
  judgePosts,
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

const judgments = await judgePosts(capturingClient, { topic, posts });

// With 3 posts and the default chunk size (8), everything happens in a single systemOne
// call, so rel_<i>/spam_<i> in that one response map directly back to posts[i].
const [response] = rawResponses;

console.log(`topic: ${topic}`);
console.log();

const columns = ["id", "raw score", "probabilities", "mapped relevance", "isSpam", "spamScore"];
const rows = judgments.map((judgment, i) => {
  const relAnswer = response?.answers[`rel_${i}`];
  return [
    judgment.id,
    relAnswer?.score !== undefined ? relAnswer.score.toFixed(3) : "n/a",
    relAnswer?.probabilities ? JSON.stringify(relAnswer.probabilities) : "n/a",
    String(judgment.relevance),
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
