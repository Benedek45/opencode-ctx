import type { ProfileName } from "../types/config.js";
import type { ToolClassConfig } from "../types/config.js";
/** Profile-level overrides applied on top of defaults. */
export interface ProfileOverrides {
    /** Prefer offloading (stateless) over plain masking. */
    preferOffload: boolean;
    /** For stateful tools: use plain mask instead of stateful mask. */
    usePlainMaskForStateful: boolean;
    /** Recency guard turns override (undefined = use default). */
    recencyGuardTurns?: number;
    /** Mask trigger threshold override (undefined = use default). */
    maskTriggerThreshold?: number;
    /** Tool class overrides specific to this profile. */
    toolClassOverrides?: Record<string, Partial<ToolClassConfig>>;
}
/** Profile definitions. */
export declare const PROFILES: Record<ProfileName, ProfileOverrides>;
/** Get the profile overrides for a given profile name. */
export declare function getProfile(name: ProfileName): ProfileOverrides;
//# sourceMappingURL=profiles.d.ts.map