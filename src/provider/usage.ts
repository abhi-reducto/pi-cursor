import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";

export interface CursorTokenDetails {
  usedTokens: number;
  maxTokens: number;
}

/**
 * Populate Pi's `usage` and `usage.cost` from Cursor's `ConversationTokenDetails`
 * (reported via checkpoints) and streamed output token deltas.
 */
export function applyUsageAndCost(
  usage: AssistantMessage["usage"],
  model: Pick<Model<Api>, "cost" | "contextWindow">,
  tokenDetails: CursorTokenDetails | undefined,
): void {
  const usedTokens = tokenDetails?.usedTokens ?? 0;
  if (usedTokens > 0) {
    usage.input = Math.max(0, usedTokens - usage.output);
    usage.totalTokens = Math.max(
      usedTokens,
      usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
    );
  } else {
    usage.totalTokens =
      usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
  }

  const rates = model.cost;
  const inputCost = ((rates?.input ?? 0) / 1_000_000) * usage.input;
  const outputCost = ((rates?.output ?? 0) / 1_000_000) * usage.output;
  const cacheReadCost = ((rates?.cacheRead ?? 0) / 1_000_000) * usage.cacheRead;
  const cacheWriteCost =
    ((rates?.cacheWrite ?? 0) / 1_000_000) * usage.cacheWrite;

  usage.cost = {
    input: inputCost,
    output: outputCost,
    cacheRead: cacheReadCost,
    cacheWrite: cacheWriteCost,
    total: inputCost + outputCost + cacheReadCost + cacheWriteCost,
  };
}
