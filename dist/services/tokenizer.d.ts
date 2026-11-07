/** Tokenizer service interface. */
export interface Tokenizer {
    /** Estimate the number of tokens in the given text. */
    countTokens(text: string): number;
}
/**
 * Default tokenizer: approximates tokens as characters / 4.
 * Suitable for tests and rough estimates; replace with a real tokenizer in production.
 */
export declare class CharTokenizer implements Tokenizer {
    countTokens(text: string): number;
}
/** Singleton default tokenizer instance. */
export declare const defaultTokenizer: Tokenizer;
/**
 * Tokenizer that wraps a base tokenizer and applies a calibration ratio.
 *
 * The ratio is derived from observed provider-reported token counts vs local
 * estimates (e.g. CharTokenizer's len/4 which drifts ~15-40% on code-heavy
 * or JSON-heavy inputs). Updated each turn via EWMA in core/pipeline.ts.
 *
 * Once calibrated, all thresholds that depend on token counts — nudge
 * percentages, hardCap "92%", costRoi N_saved — operate on accurate values
 * instead of systematically biased estimates.
 */
export declare class CalibratedTokenizer implements Tokenizer {
    private readonly base;
    readonly ratio: number;
    constructor(base: Tokenizer, ratio: number);
    countTokens(text: string): number;
}
//# sourceMappingURL=tokenizer.d.ts.map