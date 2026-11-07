import type { NeutralMessage } from "../types/neutral.js";
import type { CoreState } from "../types/state.js";
/**
 * Apply dashboard-authored overrides after automatic pruning and the hard cap.
 * The source history remains untouched; only the outbound projection changes.
 */
export declare function applyManualOverrides(messages: NeutralMessage[], state: CoreState, originalMessages?: NeutralMessage[]): NeutralMessage[];
//# sourceMappingURL=manualOverrides.d.ts.map