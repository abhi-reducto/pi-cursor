import assert from "node:assert/strict";
import test from "node:test";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { applyUsageAndCost } from "../../src/provider/usage.js";

function createEmptyUsage(output = 0): AssistantMessage["usage"] {
  return {
    input: 0,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

test("applies Cursor checkpoint usedTokens to input/totalTokens and calculates cost", () => {
  const usage = createEmptyUsage(200);
  const model = {
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
  };

  applyUsageAndCost(usage, model, { usedTokens: 10200, maxTokens: 200000 });

  assert.equal(usage.input, 10000);
  assert.equal(usage.output, 200);
  assert.equal(usage.totalTokens, 10200);
  assert.ok(Math.abs(usage.cost.input - 0.03) < 1e-9);
  assert.ok(Math.abs(usage.cost.output - 0.003) < 1e-9);
  assert.ok(Math.abs(usage.cost.total - 0.033) < 1e-9);
});

test("falls back cleanly when checkpoint tokenDetails are absent", () => {
  const usage = createEmptyUsage(100);
  const model = {
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 },
    contextWindow: 200000,
  };

  applyUsageAndCost(usage, model, undefined);

  assert.equal(usage.input, 0);
  assert.equal(usage.output, 100);
  assert.equal(usage.totalTokens, 100);
  assert.ok(Math.abs(usage.cost.output - 0.001) < 1e-9);
  assert.ok(Math.abs(usage.cost.total - 0.001) < 1e-9);
});

test("clamps input tokens to 0 if output exceeds reported usedTokens", () => {
  const usage = createEmptyUsage(500);
  const model = {
    cost: { input: 1, output: 5, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
  };

  applyUsageAndCost(usage, model, { usedTokens: 400, maxTokens: 200000 });

  assert.equal(usage.input, 0);
  assert.equal(usage.output, 500);
  assert.equal(usage.totalTokens, 500);
});
