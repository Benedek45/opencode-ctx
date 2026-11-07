import type { NeutralMessage } from "../types/neutral.js";
import type { CoreState } from "../types/state.js";
/**
 * Prune orphaned state entries for messages and tool calls no longer in the
 * conversation. Mutates `state` in place — no return value.
 */
export declare function runStateGc(messages: NeutralMessage[], state: CoreState): void;
//# sourceMappingURL=stateGc.d.ts.map