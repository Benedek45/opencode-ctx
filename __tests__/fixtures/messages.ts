// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Test fixtures: factory functions for NeutralMessage and NeutralPart.

import type { NeutralMessage, ToolPart, TextPart } from "../../types/neutral.js";

let _msgCounter = 1;
let _callCounter = 1;

/** Reset counters for test isolation. */
export function resetCounters(): void {
  _msgCounter = 1;
  _callCounter = 1;
}

/** Create a unique message ID. */
export function msgId(n?: number): string {
  return `m${String(n ?? _msgCounter++).padStart(4, "0")}`;
}

/** Create a unique call ID. */
export function callId(n?: number): string {
  return `call_${n ?? _callCounter++}`;
}

/** Create a minimal user text message. */
export function makeUserMessage(
  text: string,
  opts: Partial<NeutralMessage> = {}
): NeutralMessage {
  return {
    id: msgId(),
    role: "user",
    sessionId: "test-session",
    createdAt: Date.now(),
    parts: [{ type: "text", text }],
    ...opts,
  };
}

/** Create a minimal assistant text message. */
export function makeAssistantMessage(
  text: string,
  opts: Partial<NeutralMessage> = {}
): NeutralMessage {
  return {
    id: msgId(),
    role: "assistant",
    sessionId: "test-session",
    createdAt: Date.now(),
    parts: [{ type: "text", text }],
    ...opts,
  };
}

/** Create a tool call message (completed by default). */
export function makeToolMessage(
  tool: string,
  input: unknown,
  output: string,
  turn: number,
  opts: Partial<NeutralMessage & { callIdOverride?: string }> = {}
): NeutralMessage {
  const cid = opts.callIdOverride ?? callId();
  const toolPart: ToolPart = {
    type: "tool",
    callId: cid,
    tool,
    status: "completed",
    input,
    output,
    turn,
  };
  return {
    id: msgId(),
    role: "assistant",
    sessionId: "test-session",
    createdAt: Date.now(),
    parts: [toolPart],
    ...opts,
  };
}

/** Create a tool call message with error status. */
export function makeErrorToolMessage(
  tool: string,
  input: unknown,
  errorOutput: string,
  turn: number,
  opts: Partial<NeutralMessage> = {}
): NeutralMessage {
  const cid = callId();
  const toolPart: ToolPart = {
    type: "tool",
    callId: cid,
    tool,
    status: "error",
    input,
    output: errorOutput,
    turn,
  };
  return {
    id: msgId(),
    role: "assistant",
    sessionId: "test-session",
    createdAt: Date.now(),
    parts: [toolPart],
    ...opts,
  };
}

/** Create a large output string of approximately `chars` characters. */
export function makeLargeOutput(chars: number): string {
  const line = "x".repeat(80) + "\n";
  const lines = Math.ceil(chars / (line.length));
  return line.repeat(lines).slice(0, chars);
}
