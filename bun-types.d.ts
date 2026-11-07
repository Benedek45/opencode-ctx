// PolyForm Noncommercial License 1.0.0 — see LICENSE
// Minimal bun:test type declarations for TypeScript.
// Bun provides these at runtime; we declare them here for tsc.

declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
  export const expect: {
    (value: unknown): Matchers;
    arrayContaining(expected: unknown[]): unknown;
  };

  interface Matchers {
    toBe(expected: unknown): void;
    toEqual(expected: unknown): void;
    toBeCloseTo(expected: number, precision?: number): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    toBeNull(): void;
    toBeNaN(): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toContain(expected: string | unknown): void;
    toHaveLength(expected: number): void;
    toThrow(expected?: string | RegExp | Error): void;
    toMatch(expected: string | RegExp): void;
    toMatchObject(expected: object): void;
    toBeInstanceOf(expected: abstract new (...args: never[]) => unknown): void;
    rejects: Matchers;
    not: Matchers;
  }
}
