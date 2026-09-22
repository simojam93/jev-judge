// client.ts — the only file in this library that may import @typesafe-ai/sdk.
//
// Everything else (judge.ts, scroll.ts) talks to Jev exclusively through the JevClient
// interface below, using plain data. That keeps the SDK's rich generic types (Questions,
// ResultFor<Q>, etc.) contained to this one seam.

import { TypeSafeClient } from "@typesafe-ai/sdk";

/** Request shape accepted by {@link JevClient.systemOne}. Intentionally loose (plain data,
 * no SDK types) so the rest of the library never needs to import `@typesafe-ai/sdk`. */
export type SystemOneRequest = { state: unknown; questions: Record<string, unknown> };

/** A single question's answer, flattened across Jev's `noul`/`score`/`choice` primitives. */
export type SystemOneAnswer = {
  noul?: number;
  score?: number;
  choice?: string;
  probabilities?: Record<string, number>;
  confidence?: number;
};

export type SystemOneResponse = { answers: Record<string, SystemOneAnswer> };

/** The only capability the rest of this library needs from a Jev client. */
export interface JevClient {
  systemOne(req: SystemOneRequest): Promise<SystemOneResponse>;
}

export type SleepFn = (ms: number) => Promise<void>;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * True when `error` looks like a Jev rate-limit (HTTP 429) or overload (HTTP 529) failure.
 *
 * The installed SDK's `APIError` (see `node_modules/@typesafe-ai/sdk/dist/index.d.mts`,
 * `//#region src/errors.d.ts`) exposes a numeric `status` field, with `RateLimitError`
 * (429) and `InternalServerError` (5xx, which covers 529) subclassing it per status code —
 * we check `status` first. As a defensive fallback for errors that aren't SDK `APIError`
 * instances (a plain `Error`, or a fake used in tests), we also match the status code
 * inside the error's message.
 */
export function isRetryableError(error: unknown): boolean {
  if (error && typeof error === "object" && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (status === 429 || status === 529) return true;
  }
  // Transport-level failures are retryable too: the SDK throws
  // `APITimeoutError` (its own 10s request timeout) and `APIConnectionError`
  // (DNS/socket/reset) with no HTTP status at all. Observed live
  // (2026-09-22): a ~50s network stall surfaced as APITimeoutError and, left
  // un-retried, failed an entire scout run. Matched by class name first,
  // then by the usual message shapes for non-SDK errors and test fakes.
  const name = error instanceof Error ? error.name : "";
  if (name === "APITimeoutError" || name === "APIConnectionError") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b(429|529)\b/.test(message) || /timed out|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(message);
}

export interface WithRetriesOptions {
  /** Maximum retries after the initial attempt; `0` disables retries. */
  maxRetries: number;
  /** Injectable delay so tests don't wait on real timers. */
  sleep: SleepFn;
  /** Defaults to {@link isRetryableError}. */
  isRetryable?: (error: unknown) => boolean;
}

/**
 * Runs `fn`, retrying up to `maxRetries` additional times while `isRetryable` returns true
 * for the thrown error. Delays double each attempt starting at 1000ms (1s, 2s, 4s, ...).
 */
export async function withRetries<T>(fn: () => Promise<T>, opts: WithRetriesOptions): Promise<T> {
  const isRetryable = opts.isRetryable ?? isRetryableError;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= opts.maxRetries || !isRetryable(error)) {
        throw error;
      }
      await opts.sleep(1000 * 2 ** attempt);
    }
  }
}

/**
 * Constructs the underlying `TypeSafeClient` with its own internal retries disabled.
 *
 * The SDK's `TypeSafeClient` retries HTTP 429/5xx internally by default (see
 * `node_modules/@typesafe-ai/sdk/dist/index.d.mts`, `//#region src/types.d.ts`,
 * `RetryPolicy.maxRetries`: "Maximum retries after the initial attempt; `0` disables
 * retries. Default: 2." — i.e. up to 3 attempts per call, retrying 408/429/500-599 by
 * default). Left enabled, that would compound with our own `withRetries` wrapper (up to 4
 * attempts with its default `maxRetries: 3`) for a worst case of 3 * 4 = 12 HTTP calls per
 * `systemOne` call. We disable it here (`retry: { maxRetries: 0 }`, per
 * `TypeSafeClientConfig.retry?: Partial<RetryPolicy>` in the same file) so `withRetries` is
 * the only retry loop, and our documented 1s/2s/4s backoff maps 1:1 to actual HTTP attempts.
 */
function createConfiguredSdkClient(): TypeSafeClient {
  return new TypeSafeClient({ retry: { maxRetries: 0 } });
}

function createSdkBackedClient(): JevClient {
  const sdkClient = createConfiguredSdkClient();
  return {
    systemOne(req: SystemOneRequest): Promise<SystemOneResponse> {
      // The SDK infers precise per-question response types from `questions` (a `Questions`
      // map of NoulQuestion/ScoreQuestion/ChoiceQuestion). Our public seam intentionally
      // trades that away for a plain `Record<string, unknown>` so the rest of this library
      // never has to import `@typesafe-ai/sdk` types. judge.ts/scroll.ts always build
      // `req.questions` as plain objects already shaped like the SDK's question types, so
      // this cast just bridges the two type systems at the one place they meet.
      return sdkClient.systemOne(req as any) as unknown as Promise<SystemOneResponse>;
    },
  };
}

/**
 * @internal Test-only seam: exposes the configured `TypeSafeClient` itself (rather than the
 * `JevClient`-wrapped version) so tests can assert on its resolved `retry` policy — a public
 * readonly property — without making a network call.
 */
export function createConfiguredSdkClientForTesting(): TypeSafeClient {
  return createConfiguredSdkClient();
}

function wrapWithRetries(inner: JevClient, opts?: { maxRetries?: number; sleep?: SleepFn }): JevClient {
  const maxRetries = opts?.maxRetries ?? 3;
  const sleep = opts?.sleep ?? defaultSleep;
  return {
    systemOne(req: SystemOneRequest): Promise<SystemOneResponse> {
      return withRetries(() => inner.systemOne(req), { maxRetries, sleep });
    },
  };
}

/**
 * Creates a {@link JevClient} backed by `@typesafe-ai/sdk`'s `TypeSafeClient`, wrapping every
 * `systemOne` call with retry-with-backoff on HTTP 429 (rate limited) and 529 (overloaded)
 * failures. Requires `TYPESAFE_API_KEY` to be set (see the SDK's `TypeSafeClientConfig`).
 */
export function createJevClient(opts?: { maxRetries?: number; sleep?: SleepFn }): JevClient {
  return wrapWithRetries(createSdkBackedClient(), opts);
}

/**
 * @internal Test-only seam: same retry wrapping as {@link createJevClient}, but around a
 * caller-supplied `JevClient` instead of a real `TypeSafeClient`. Not re-exported from
 * `index.ts` — this library's own tests import it directly from `./client.js` to exercise
 * the createJevClient → withRetries wiring end-to-end without a network call or API key.
 */
export function createJevClientForTesting(
  client: JevClient,
  opts?: { maxRetries?: number; sleep?: SleepFn }
): JevClient {
  return wrapWithRetries(client, opts);
}
