import { describe, expect, it } from "vitest";
import * as lib from "./index.js";

describe("index exports", () => {
  it("exports createJevClient", () => {
    expect(typeof lib.createJevClient).toBe("function");
  });

  it("exports judgePosts", () => {
    expect(typeof lib.judgePosts).toBe("function");
  });

  it("exports shouldContinueScrolling", () => {
    expect(typeof lib.shouldContinueScrolling).toBe("function");
  });
});
