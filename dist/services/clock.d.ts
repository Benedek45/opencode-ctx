/** Clock service interface. Core uses this instead of Date.now() directly. */
export interface Clock {
    /** Returns the current time as Unix milliseconds. */
    now(): number;
}
/** Real wall-clock implementation. */
export declare class WallClock implements Clock {
    now(): number;
}
/** Fake clock for deterministic tests. */
export declare class FakeClock implements Clock {
    private _now;
    constructor(initialMs?: number);
    now(): number;
    /** Advance the clock by the given number of milliseconds. */
    advance(ms: number): void;
    /** Set the clock to an absolute value. */
    set(ms: number): void;
}
/** Singleton real clock. */
export declare const wallClock: Clock;
//# sourceMappingURL=clock.d.ts.map