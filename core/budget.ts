// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Budget accounting: token category breakdown and threshold checks.

import type { NeutralMessage } from "../types/neutral.js";
import type { CoreConfig } from "../types/config.js";
import type { Tokenizer } from "../services/tokenizer.js";
import { estimateMessageTokens, computeEffectiveBudget, resolveThreshold } from "./tokens.js";

/** Token budget breakdown by category. */
export interface BudgetBreakdown {
  systemAndTools: number;
  documents: number;
  reasoning: number;
  conversation: number;
  total: number;
  effectiveBudget: number;
  usedFraction: number;
}

/** Compute a rough budget breakdown from a list of messages. */
export function computeBudgetBreakdown(
  messages: NeutralMessage[],
  config: CoreConfig,
  tokenizer: Tokenizer
): BudgetBreakdown {
  let documents = 0;
  let reasoning = 0;
  let conversation = 0;

  for (const msg of messages) {
    if (msg.isIgnored) continue;
    for (const part of msg.parts) {
      if (part.type === "reasoning") {
        reasoning += tokenizer.countTokens(part.text);
      } else if (part.type === "tool") {
        // Tool outputs from read/webfetch/websearch count as documents
        const toolName = part.tool.toLowerCase();
        const isDocTool = ["read", "webfetch", "websearch"].includes(toolName);
        const tokens = estimateMessageTokens(
          { ...msg, parts: [part] },
          tokenizer
        );
        if (isDocTool) {
          documents += tokens;
        } else {
          conversation += tokens;
        }
      } else if (part.type === "text" || part.type === "step-start") {
        conversation += estimateMessageTokens(
          { ...msg, parts: [part] },
          tokenizer
        );
      } else if (part.type === "summary-block") {
        conversation += tokenizer.countTokens(part.text);
      }
    }
  }

  const systemAndTools = config.systemPromptTokens;
  const total = systemAndTools + documents + reasoning + conversation;
  const effectiveBudget = computeEffectiveBudget(
    config.modelContextLimit,
    config.nudges.safetyCap,
    config.systemPromptTokens
  );
  const usedFraction = effectiveBudget > 0 ? total / effectiveBudget : 0;

  return { systemAndTools, documents, reasoning, conversation, total, effectiveBudget, usedFraction };
}

/** Check whether the current token count exceeds a threshold. */
export function exceedsThreshold(totalTokens: number, threshold: number): boolean {
  return totalTokens >= threshold;
}

/** Check whether masking should be triggered. */
export function shouldTriggerMasking(
  totalTokens: number,
  config: CoreConfig
): boolean {
  return totalTokens >= resolveThreshold(config.nudges.maskTriggerThreshold, config.modelContextLimit);
}
