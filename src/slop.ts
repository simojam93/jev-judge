import type { JevClient, SystemOneAnswer } from "./client.js";
import { clamp, normalizeScore } from "./normalize.js";

/**
 * The five ordered levels of the `slop` question. They target the STYLISTIC FINGERPRINTS of
 * large-language-model prose, not how generic or vague the content is.
 *
 * Why (measured 2026-09-22 on 10 drafts written by Claude plus 4 loose human posts): the
 * previous rubric asked how "generic / padded" the text was, and every AI draft scored 0–32
 * ("human") because they were specific and confident — genericness is simply not what gives
 * LLM writing away. This rubric — balanced parallel clauses, tricolons, em-dash asides, a tidy
 * summarizing last line, "not X, but Y", no typos/slang/looseness — scored the same AI drafts
 * 40–94 and the human posts 0–34.
 */
const SLOP_LEVELS = [
  "none of these fingerprints — loose, uneven, human rhythm (typos, fragments, slang, tangents)",
  "one faint fingerprint",
  "a couple of fingerprints, but the voice is still uneven",
  "several fingerprints: polished, parallel, no wasted words",
  "textbook LLM prose: balanced tricolons, em-dashes, a neat closing line, zero looseness",
] as const;

const SLOP_INSTRUCTIONS =
  "Rate how strongly this social post shows the STYLISTIC FINGERPRINTS of large-language-model writing, " +
  "regardless of how specific or confident it sounds: perfectly balanced parallel clauses, 'not X, but Y' or " +
  "'X. Y. Z.' tricolons, em-dash asides, tidy summarizing last lines, hooks like 'Here's the thing', absence of " +
  "typos/slang/loose grammar, every sentence load-bearing with no throwaway words.";

const DEFAULT_BORDERLINE_THRESHOLD = 35;
const DEFAULT_SLOP_THRESHOLD = 60;
const FILLER_THRESHOLD = 0.5;

export type SlopVerdict = "human" | "borderline" | "slop";

export type SlopCheck = {
  slopScore: number; // 0..100, higher = more AI-slop
  confidence: number; // 0..1 from the score answer
  verdict: SlopVerdict; // thresholds: <35 human, <60 borderline, else slop
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
 * levels of LLM stylistic fingerprints — see SLOP_LEVELS for why it is NOT a genericness
 * scale) and a `noul`
 * question (`filler`, whether the text is padded with generic filler). `slopScore` is
 * mapped from the `slop` answer via the same expected-value normalization `judgePosts` uses
 * for `relevance` (see {@link normalizeScore}): probabilities-weighted when Jev reports
 * them, else raw score / (levelCount - 1). `verdict` buckets `slopScore` against
 * `args.thresholds` (default: below 35 "human", below 60 "borderline", else "slop").
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
        instructions: SLOP_INSTRUCTIONS,
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
