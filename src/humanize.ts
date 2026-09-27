import type { SlopVerdict } from "./slop.js";

/** A text's AI-style score as the loop reads it: {@link checkSlop}'s `slopScore` (0..100, higher = more AI) and `verdict`. */
export type HumanizeScore = { slopScore: number; verdict: SlopVerdict | string };

/** One round's outcome: the rewrite's score, or nulls when it couldn't be scored. */
export type HumanizeRound = { round: number; slopScore: number | null; verdict: string | null };

/** Where the loop is, told before each rewrite and each check. */
export type HumanizeStep = { round: number; maxRounds: number; phase: "rewriting" | "checking"; rounds: HumanizeRound[] };

/** What the writer gets each round: the original, and after round 1 the last try with its score. */
export type HumanizeRewriteInput = {
  original: string;
  round: number;
  previous: ({ text: string } & HumanizeScore) | null;
};

export const HUMANIZE_MAX_ROUNDS = 3;

/**
 * Rewrites a text until it reads human: your writer (an LLM, say) rewrites,
 * Jev scores the rewrite, and while Jev doesn't call it "human" the writer
 * tries again from the original with the last try and its score in hand — at
 * most `maxRounds` times (default 3). Returns the best-scored rewrite, not
 * necessarily the last, with every round's score.
 *
 * `rewrite` is yours: jev-judge judges, it doesn't write. Give it
 * {@link AI_STYLE_FINGERPRINTS} so it knows what Jev looks for. `score` is
 * usually `(text) => checkSlop(client, { text })`; without it, the loop runs
 * one round, unscored.
 *
 * Degrades rather than fails: a check that throws stops the loop after that
 * round, and a rewrite that throws after round 1 keeps the best one so far.
 * Only a first-round rewrite failure is thrown.
 */
export async function humanize(args: {
  original: string;
  rewrite: (input: HumanizeRewriteInput) => Promise<string>;
  score?: (text: string) => Promise<HumanizeScore>;
  maxRounds?: number;
  onStep?: (step: HumanizeStep) => void | Promise<void>;
}): Promise<{ text: string; rounds: HumanizeRound[]; score: HumanizeScore | null }> {
  const { original, rewrite, score, onStep } = args;
  if (original.trim().length === 0) throw new Error("jev-judge: humanize needs a text");
  const maxRounds = Math.max(1, Math.floor(args.maxRounds ?? HUMANIZE_MAX_ROUNDS));
  const rounds: HumanizeRound[] = [];
  let best: { text: string; score: HumanizeScore | null } | null = null;
  let previous: ({ text: string } & HumanizeScore) | null = null;

  const step = async (round: number, phase: HumanizeStep["phase"]) => {
    if (!onStep) return;
    try {
      await onStep({ round, maxRounds, phase, rounds: rounds.map((r) => ({ ...r })) });
    } catch {
      // Progress is a courtesy to whoever is watching; the rewrite goes on.
    }
  };

  for (let round = 1; round <= maxRounds; round++) {
    await step(round, "rewriting");
    let text: string;
    try {
      text = await rewrite({ original, round, previous });
    } catch (e) {
      if (!best) throw e;
      break;
    }

    let scored: HumanizeScore | null = null;
    if (score) {
      await step(round, "checking");
      try {
        scored = await score(text);
      } catch {
        scored = null;
      }
    }
    rounds.push({ round, slopScore: scored?.slopScore ?? null, verdict: scored?.verdict ?? null });

    if (!best || (scored && (best.score === null || scored.slopScore < best.score.slopScore))) best = { text, score: scored };
    if (!scored || scored.verdict === "human") break;
    previous = { text, slopScore: scored.slopScore, verdict: scored.verdict };
  }

  // The loop always runs a first round and throws if that one fails, so best is set here.
  return { text: best!.text, rounds, score: best!.score };
}
