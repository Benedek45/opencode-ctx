import type { Logger } from "../../services/logger.js";
import type { NeutralMessage } from "../../types/neutral.js";
import type { CoreState } from "../../types/state.js";
import type { OffloadRequest } from "../../core/strategies/observationMask.js";
export declare function materializeOffloadRequests(requests: OffloadRequest[], state: CoreState, logger: Logger): Promise<Set<string>>;
export declare function restoreFailedOffloadOutputs(projected: NeutralMessage[], raw: NeutralMessage[], failed: Set<string>): NeutralMessage[];
//# sourceMappingURL=offload-writer.d.ts.map