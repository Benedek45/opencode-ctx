// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Config precedence resolution: plugin < global < per-provider < per-model < runtime.
import { buildDefaultConfig } from "./defaults.js";
import { getProfile } from "./profiles.js";
/**
 * Merge configuration with precedence:
 * defaults < plugin < global < per-provider < per-model < runtime
 *
 * Later layers override earlier ones. Nested objects (cacheModel, nudges, etc.)
 * are merged shallowly (each key overrides independently).
 */
export function resolveConfig(sessionId, plugin, global, provider, model, runtime) {
    const base = buildDefaultConfig(sessionId);
    // Determine the effective profile from the highest-precedence layer that
    // specifies one (runtime > model > provider > global > plugin > default).
    // We must resolve this BEFORE merging the layers so we can apply the
    // profile as a DEFAULTS layer — meaning explicit per-model or per-provider
    // values (e.g. recencyGuardTurns: 25) correctly override the profile's
    // default for that field.
    //
    // Previously profiles were applied POST-merge, which silently clobbered
    // explicit overrides (e.g. the "code" profile's recencyGuardTurns: 15
    // would win over an explicit model-level recencyGuardTurns: 25).
    const effectiveProfile = runtime?.profile ??
        model?.profile ??
        provider?.profile ??
        global?.profile ??
        plugin?.profile ??
        base.profile;
    const profileOverrides = getProfile(effectiveProfile);
    if (profileOverrides.recencyGuardTurns !== undefined) {
        base.recencyGuardTurns = profileOverrides.recencyGuardTurns;
    }
    if (profileOverrides.maskTriggerThreshold !== undefined) {
        base.nudges = { ...base.nudges, maskTriggerThreshold: profileOverrides.maskTriggerThreshold };
    }
    base.profile = effectiveProfile;
    const layers = [plugin, global, provider, model, runtime].filter(Boolean);
    let result = { ...base };
    for (const layer of layers) {
        // Merge top-level scalar fields
        for (const key of Object.keys(layer)) {
            const val = layer[key];
            if (val === undefined)
                continue;
            if (key === "cacheModel" && typeof val === "object") {
                result.cacheModel = { ...result.cacheModel, ...val };
            }
            else if (key === "costRoi" && typeof val === "object") {
                result.costRoi = { ...result.costRoi, ...val };
            }
            else if (key === "automation" && typeof val === "object") {
                result.automation = { ...result.automation, ...val };
            }
            else if (key === "contextTiers" && typeof val === "object") {
                result.contextTiers = { ...result.contextTiers, ...val };
            }
            else if (key === "cachePrune" && typeof val === "object") {
                result.cachePrune = { ...result.cachePrune, ...val };
            }
            else if (key === "summarization" && typeof val === "object") {
                result.summarization = { ...result.summarization, ...val };
            }
            else if (key === "nearDupe" && typeof val === "object") {
                result.nearDupe = { ...result.nearDupe, ...val };
            }
            else if (key === "nudges" && typeof val === "object") {
                result.nudges = { ...result.nudges, ...val };
            }
            else if (key === "toolClasses" && typeof val === "object") {
                result.toolClasses = { ...result.toolClasses, ...val };
            }
            else {
                // Scalar override
                result[key] = val;
            }
        }
    }
    // NOTE: profile is applied as a defaults layer above, NOT here. Any explicit
    // layer that sets recencyGuardTurns / maskTriggerThreshold in the loop above
    // will correctly override the profile default.
    return result;
}
//# sourceMappingURL=config.js.map