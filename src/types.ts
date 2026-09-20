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

export type JudgeOptions = { chunkSize?: number; spamThreshold?: number; maxRetries?: number };
