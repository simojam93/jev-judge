import { describe, expect, it, vi } from "vitest";
import {
  createJevClient,
  createJevClientForTesting,
  isRetryableError,
  withRetries,
  type JevClient,
  type SystemOneResponse,
} from "./client.js";

function statusError(status: number, message: string): Error & { status: number } {
  const err = new Error(message) as Error & { status: number };
  err.status = status;
  return err;
}

describe("isRetryableError", () => {
  it("is true for an error with status 429", () => {
    expect(isRetryableError(statusError(429, "Too Many Requests"))).toBe(true);
  });

  it("is true for an error with status 529", () => {
    expect(isRetryableError(statusError(529, "Overloaded"))).toBe(true);
  });

  it("is false for an error with an unrelated status", () => {
    expect(isRetryableError(statusError(400, "Bad Request"))).toBe(false);
  });

  it("falls back to matching the status code inside the message when there is no status field", () => {
    expect(isRetryableError(new Error("request failed with status 429"))).toBe(true);
  });

  it("is false for an unrelated plain error", () => {
    expect(isRetryableError(new Error("boom"))).toBe(false);
  });

  it("is false for non-error values", () => {
    expect(isRetryableError("nope")).toBe(false);
    expect(isRetryableError(null)).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});

describe("withRetries", () => {
  it("returns the result immediately when fn succeeds on the first try", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await withRetries(fn, { maxRetries: 3, sleep });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries a 429 with 1s/2s/4s backoff and returns the eventual success", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls <= 2) throw statusError(429, "Too Many Requests");
      return "recovered";
    });

    const result = await withRetries(fn, { maxRetries: 3, sleep });

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[1000], [2000]]);
  });

  it("retries a 529 (overloaded) failure", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw statusError(529, "Overloaded");
      return "ok";
    });

    const result = await withRetries(fn, { maxRetries: 3, sleep });

    expect(result).toBe("ok");
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("gives up after maxRetries and rethrows the last error", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const err = statusError(429, "Too Many Requests");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetries(fn, { maxRetries: 2, sleep })).rejects.toBe(err);

    expect(fn).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-retryable error", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const err = statusError(400, "Bad Request");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(withRetries(fn, { maxRetries: 3, sleep })).rejects.toBe(err);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("honors a custom isRetryable predicate", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let calls = 0;
    const fn = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("custom-retryable");
      return "ok";
    });

    const result = await withRetries(fn, {
      maxRetries: 1,
      sleep,
      isRetryable: (error) => error instanceof Error && error.message === "custom-retryable",
    });

    expect(result).toBe("ok");
    expect(sleep).toHaveBeenCalledTimes(1);
  });
});

describe("createJevClient", () => {
  it("wraps an injected inner client and retries retryable failures", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    let calls = 0;
    const response: SystemOneResponse = { answers: { q: { noul: 1 } } };
    const fakeInner: JevClient = {
      systemOne: vi.fn(async () => {
        calls++;
        if (calls === 1) throw statusError(429, "Too Many Requests");
        return response;
      }),
    };

    const client = createJevClientForTesting(fakeInner, { sleep });
    const result = await client.systemOne({ state: null, questions: {} });

    expect(result).toBe(response);
    expect(fakeInner.systemOne).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("defaults maxRetries to 3 when not specified", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const err = statusError(429, "Too Many Requests");
    const fakeInner: JevClient = { systemOne: vi.fn().mockRejectedValue(err) };

    const client = createJevClientForTesting(fakeInner, { sleep });

    await expect(client.systemOne({ state: null, questions: {} })).rejects.toBe(err);
    expect(fakeInner.systemOne).toHaveBeenCalledTimes(4); // 1 + default 3 retries
  });

  it("passes the request through to the inner client unchanged", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const response: SystemOneResponse = { answers: {} };
    const fakeInner: JevClient = { systemOne: vi.fn().mockResolvedValue(response) };
    const request = { state: { topic: "x" }, questions: { a: { type: "noul" } } };

    const client = createJevClientForTesting(fakeInner, { sleep });
    await client.systemOne(request);

    expect(fakeInner.systemOne).toHaveBeenCalledWith(request);
  });

  it("builds a real SDK-backed client when no override is given", () => {
    const previous = process.env.TYPESAFE_API_KEY;
    process.env.TYPESAFE_API_KEY = "test-key";
    try {
      const client = createJevClient();
      expect(typeof client.systemOne).toBe("function");
    } finally {
      if (previous === undefined) delete process.env.TYPESAFE_API_KEY;
      else process.env.TYPESAFE_API_KEY = previous;
    }
  });
});
