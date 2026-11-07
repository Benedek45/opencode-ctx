import { describe, expect, it } from "bun:test";
import { OffloadCleanupScheduler } from "../adapters/opencode/offload-cleanup.js";

describe("background offload cleanup scheduling", () => {
  it("coalesces overlapping scans and throttles subsequent same-session re-feeds", async () => {
    let now = 0;
    let scans = 0;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const scheduler = new OffloadCleanupScheduler(600_000, 16, () => now);
    const first = scheduler.request("/offloads/s1", async () => { scans++; await blocked; });
    const second = scheduler.request("/offloads/s1", async () => { scans++; });
    expect(second).toBe(first);
    await Promise.resolve();
    expect(scans).toBe(1);
    release();
    await first;
    now = 599_999;
    await scheduler.request("/offloads/s1", async () => { scans++; });
    expect(scans).toBe(1);
    now = 600_000;
    await scheduler.request("/offloads/s1", async () => { scans++; });
    expect(scans).toBe(2);
  });

  it("does not let one session's scan block another and uses the fresh callback at the next interval", async () => {
    let now = 0;
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const scheduler = new OffloadCleanupScheduler(10, 2, () => now);
    const scanned: string[] = [];
    const first = scheduler.request("/offloads/s1", async () => { scanned.push("s1-old"); await blocked; });
    await scheduler.request("/offloads/s2", async () => { scanned.push("s2"); });
    expect(scanned).toEqual(["s1-old", "s2"]);
    release();
    await first;
    now = 10;
    await scheduler.request("/offloads/s1", async () => { scanned.push("s1-fresh"); });
    expect(scanned).toEqual(["s1-old", "s2", "s1-fresh"]);
  });

  it("throttles failed scans without poisoning future retries", async () => {
    let now = 0;
    let scans = 0;
    const scheduler = new OffloadCleanupScheduler(10, 2, () => now);
    await expect(scheduler.request("/offloads/s1", async () => {
      scans++;
      throw new Error("filesystem unavailable");
    })).rejects.toThrow("filesystem unavailable");
    await scheduler.request("/offloads/s1", async () => { scans++; });
    expect(scans).toBe(1);
    now = 10;
    await scheduler.request("/offloads/s1", async () => { scans++; });
    expect(scans).toBe(2);
  });

  it("bounds the remembered abandoned-session keys", async () => {
    const scheduler = new OffloadCleanupScheduler(100, 2, () => 0);
    let scans = 0;
    for (const id of ["s1", "s2", "s3", "s2"]) {
      await scheduler.request(id, async () => { scans++; });
    }
    expect(scans).toBe(3);
    await scheduler.request("s1", async () => { scans++; });
    expect(scans).toBe(4);
  });
});
