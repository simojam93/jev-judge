import { describe, expect, it } from "vitest";
import * as lib from "./index.js";

describe("index exports", () => {
  it("exports createJevClient", () => {
    expect(typeof lib.createJevClient).toBe("function");
  });

  it("exports judgePosts", () => {
    expect(typeof lib.judgePosts).toBe("function");
  });

  it("exports sortByRank", () => {
    expect(typeof lib.sortByRank).toBe("function");
  });

  it("exports shouldContinueScrolling", () => {
    expect(typeof lib.shouldContinueScrolling).toBe("function");
  });

  it("exports checkSlop", () => {
    expect(typeof lib.checkSlop).toBe("function");
  });

  it("exports humanize and what its writer needs", () => {
    expect(typeof lib.humanize).toBe("function");
    expect(typeof lib.AI_STYLE_FINGERPRINTS).toBe("string");
  });

  it("exports learning from choices, and the writer's brief", () => {
    expect(typeof lib.learnFromChoices).toBe("function");
    expect(typeof lib.readStyleTraits).toBe("function");
    expect(typeof lib.contrastTraits).toBe("function");
    expect(typeof lib.styleLessons).toBe("function");
    expect(typeof lib.guideUpdatePrompt).toBe("function");
    expect(typeof lib.parseGuideUpdate).toBe("function");
    expect(lib.STYLE_TRAITS.length).toBeGreaterThan(0);
  });
});
