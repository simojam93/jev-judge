import type { JevClient, SystemOneAnswer } from "./client.js";
import { clamp, normalizeScore } from "./normalize.js";

const SLOP_LEVELS = [
  "reads like a specific human wrote it — concrete, opinionated, lived-in",
  "mostly human — a few stock phrases",
  "mixed — noticeable templated patterns",
  "largely generic — AI-typical structure and hedging",
  "obvious AI slop — hollow, padded, interchangeable",
] as const;

const DEFAULT_BORDERLINE_THRESHOLD = 35;
const DEFAULT_SLOP_THRESHOLD = 65;
const FILLER_THRESHOLD = 0.5;

export type SlopVerdict = "human" | "borderline" | "slop";

export type SlopCheck = {
  slopScore: number; // 0..100, higher = more AI-slop
  confidence: number; // 0..1 from the score answer
  verdict: SlopVerdict; // thresholds: <35 human, <65 borderline, else slop
  genericFiller: boolean; // noul >= 0.5: padded with generic filler phrases
  fillerScore: number; // raw noul 0..1
};

function verdictFor(slopScore: number, thresholds?: { borderline?: number; slop?: number }): SlopVerdict {
  const borderline = thresholds?.borderline ?? DEFAULT_BORDERLINE_THRESHOLD;
  const slopThreshold = thresholds?.slop ?? DEFAULT_SLOP_THRESHOLD;
  if (slopScore < borderline) return "human";
  if (slopScore < slopThreshold) return "borderline";
  return "slop";
}

/**
 * Pre-publish self-check that flags AI-sounding drafts before they go out, via one Jev
 * `systemOne` call.
 *
 * Asks two calibrated questions over `args.text`: a `score` question (`slop`, 5 ordered
 * levels from "reads like a specific human wrote it" to "obvious AI slop") and a `noul`
 * question (`filler`, whether the text is padded with generic filler). `slopScore` is
 * mapped from the `slop` answer via the same expected-value normalization `judgePosts` uses
 * for `relevance` (see {@link normalizeScore}): probabilities-weighted when Jev reports
 * them, else raw score / (levelCount - 1). `verdict` buckets `slopScore` against
 * `args.thresholds` (default: below 35 "human", below 65 "borderline", else "slop").
 */
export async function checkSlop(
  client: JevClient,
  args: { text: string; platform?: "x" | "linkedin"; thresholds?: { borderline?: number; slop?: number } }
): Promise<SlopCheck> {
  const { text, platform, thresholds } = args;
  if (text.trim().length === 0) {
    throw new Error("text is required");
  }

  const response = await client.systemOne({
    state: { platform: platform ?? "generic", text },
    questions: {
      slop: {
        type: "score",
        instructions:
          "How much does this text read like specific, lived-in human writing versus generic AI-generated slop?",
        criteria: SLOP_LEVELS,
      },
      filler: {
        type: "noul",
        instructions: "Is this text padded with generic filler phrases, hollow engagement hooks, or AI-typical boilerplate?",
        criteria: {
          true: "The text is padded with generic filler phrases, hollow engagement hooks, or AI-typical boilerplate.",
          false: "The text is specific and substantive, without generic filler or boilerplate.",
        },
      },
    },
  });

  const slopAnswer: SystemOneAnswer | undefined = response.answers.slop;
  const fillerAnswer: SystemOneAnswer | undefined = response.answers.filler;

  const normalized = normalizeScore(slopAnswer?.score, SLOP_LEVELS.length, slopAnswer?.probabilities);
  const slopScore = clamp(Math.round(normalized * 100), 0, 100);
  const confidence = slopAnswer?.confidence ?? 0;
  const fillerScore = fillerAnswer?.noul ?? 0;
  const genericFiller = fillerScore >= FILLER_THRESHOLD;

  return {
    slopScore,
    confidence,
    verdict: verdictFor(slopScore, thresholds),
    genericFiller,
    fillerScore,
  };
}
