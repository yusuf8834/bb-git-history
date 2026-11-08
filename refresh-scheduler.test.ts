import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createRefreshScheduler,
  URGENT_REFRESH_DELAY_MS,
  WORK_STATUS_REFRESH_INTERVAL_MS,
} from "./refresh-scheduler";

describe("refresh scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces a burst of urgent changes into one quick refresh", () => {
    const published: string[] = [];
    const scheduler = createRefreshScheduler((threadId) => published.push(threadId));

    scheduler.request("thread-1", "urgent");
    scheduler.request("thread-1", "urgent");
    scheduler.request("thread-1", "work-status");
    vi.advanceTimersByTime(URGENT_REFRESH_DELAY_MS);

    expect(published).toEqual(["thread-1"]);
  });

  it("refreshes working-tree edits at most once per interval while an urgent change still lands quickly", () => {
    const published: number[] = [];
    const scheduler = createRefreshScheduler(() => published.push(Date.now()));
    const start = Date.now();

    scheduler.request("thread-1", "work-status");
    vi.advanceTimersByTime(URGENT_REFRESH_DELAY_MS);
    for (let elapsed = 0; elapsed < WORK_STATUS_REFRESH_INTERVAL_MS * 2; elapsed += 500) {
      scheduler.request("thread-1", "work-status");
      vi.advanceTimersByTime(500);
    }
    expect(published.map((at) => at - start)).toEqual([
      URGENT_REFRESH_DELAY_MS,
      URGENT_REFRESH_DELAY_MS + WORK_STATUS_REFRESH_INTERVAL_MS,
      URGENT_REFRESH_DELAY_MS + WORK_STATUS_REFRESH_INTERVAL_MS * 2,
    ]);

    scheduler.request("thread-1", "work-status");
    const beforeUrgent = Date.now();
    scheduler.request("thread-1", "urgent");
    vi.advanceTimersByTime(URGENT_REFRESH_DELAY_MS);
    expect(published.at(-1)! - beforeUrgent).toBe(URGENT_REFRESH_DELAY_MS);
  });

  it("drops pending refreshes for forgotten threads and on dispose", () => {
    const published: string[] = [];
    const scheduler = createRefreshScheduler((threadId) => published.push(threadId));

    scheduler.request("thread-1", "urgent");
    scheduler.request("thread-2", "urgent");
    scheduler.forget("thread-1");
    vi.advanceTimersByTime(URGENT_REFRESH_DELAY_MS);
    expect(published).toEqual(["thread-2"]);

    scheduler.request("thread-2", "urgent");
    scheduler.dispose();
    vi.advanceTimersByTime(WORK_STATUS_REFRESH_INTERVAL_MS);
    expect(published).toEqual(["thread-2"]);
  });
});
