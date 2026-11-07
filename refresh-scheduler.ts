export const URGENT_REFRESH_DELAY_MS = 300;
export const WORK_STATUS_REFRESH_INTERVAL_MS = 15_000;

interface ThreadRefresh {
  at: number;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Coalesces refresh requests per thread. Ref, branch and turn-end changes
 * refresh within URGENT_REFRESH_DELAY_MS; working-tree edits refresh at most
 * once per WORK_STATUS_REFRESH_INTERVAL_MS, so an agent editing files never
 * makes the panel read git more often than a 15-second poll did.
 */
export function createRefreshScheduler(
  publish: (threadId: string) => void,
  now: () => number = Date.now,
) {
  const scheduled = new Map<string, ThreadRefresh>();
  const lastRefreshAt = new Map<string, number>();

  function flush(threadId: string): void {
    scheduled.delete(threadId);
    lastRefreshAt.set(threadId, now());
    publish(threadId);
  }

  return {
    request(threadId: string, urgency: "urgent" | "work-status"): void {
      const earliest = now() + URGENT_REFRESH_DELAY_MS;
      const at = urgency === "urgent"
        ? earliest
        : Math.max(
          earliest,
          (lastRefreshAt.get(threadId) ?? Number.NEGATIVE_INFINITY)
            + WORK_STATUS_REFRESH_INTERVAL_MS,
        );
      const existing = scheduled.get(threadId);
      if (existing !== undefined && existing.at <= at) return;
      if (existing !== undefined) clearTimeout(existing.timer);
      scheduled.set(threadId, {
        at,
        timer: setTimeout(() => flush(threadId), at - now()),
      });
    },
    forget(threadId: string): void {
      const existing = scheduled.get(threadId);
      if (existing !== undefined) clearTimeout(existing.timer);
      scheduled.delete(threadId);
      lastRefreshAt.delete(threadId);
    },
    dispose(): void {
      for (const { timer } of scheduled.values()) clearTimeout(timer);
      scheduled.clear();
      lastRefreshAt.clear();
    },
  };
}
