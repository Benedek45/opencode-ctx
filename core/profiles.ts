// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Profile definitions: documents (default), code, balanced.

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
export const PROFILES: Record<ProfileName, ProfileOverrides> = {
  /**
   * documents (default): aggressive offload for stateless tools.
   * Best for document-heavy compliance workflows.
   */
  documents: {
    preferOffload: true,
    usePlainMaskForStateful: false,
    recencyGuardTurns: undefined,
    maskTriggerThreshold: undefined,
  },

  /**
   * code: conservative masking; plain mask for non-re-fetchable tools
   * (preserves context for debugging). Recency guard in user-turn units:
   * 8 back-and-forths keeps the active debugging thread fully visible.
   */
  code: {
    preferOffload: false,
    usePlainMaskForStateful: true,
    recencyGuardTurns: 8,
    maskTriggerThreshold: 200_000,
  },

  /**
   * balanced: midpoint between documents and code.
   */
  balanced: {
    preferOffload: true,
    usePlainMaskForStateful: true,
    recencyGuardTurns: undefined,
    maskTriggerThreshold: 175_000,
  },
};

/** Get the profile overrides for a given profile name. */
export function getProfile(name: ProfileName): ProfileOverrides {
  return PROFILES[name];
}
