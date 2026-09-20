export type PostInput = {
  id: string;
  text: string;
  author?: string;
  metrics?: { likes?: number; reposts?: number; replies?: number };
};

export type PostJudgment = {
  id: string;
  relevance: number;
  relevanceConfidence: number;
  isSpam: boolean;
  spamScore: number;
};

// Note: retries are a concern of the client returned by `createJevClient` (constructed
// separately and passed in), not of `judgePosts` itself, so there is no `maxRetries` here.
export type JudgeOptions = { chunkSize?: number; spamThreshold?: number };
