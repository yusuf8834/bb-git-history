import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { hostContract, rpcContract, threadHistoryTag } from "./contracts";
import { createRefreshScheduler } from "./refresh-scheduler";

export { rpcContract } from "./contracts";

interface RepositoryTarget {
  hostId: string;
  environmentPath: string;
}

class RepositoryUnavailableError extends Error {}

function repositoryInput(
  target: RepositoryTarget,
  repositoryKey: string | undefined,
) {
  return {
    environmentPath: target.environmentPath,
    ...(repositoryKey === undefined ? {} : { repositoryKey }),
  };
}

const URGENT_ENVIRONMENT_CHANGES = new Set<string>([
  "git-refs-changed",
  "git-branches-changed",
  "metadata-changed",
  "status-changed",
  "environment-created",
  "environment-deleted",
]);

async function repositoryForThread(
  bb: BbPluginApi,
  threadId: string,
): Promise<RepositoryTarget> {
  const thread = await bb.sdk.threads.get({
    threadId,
    include: "environment",
  });

  if (!("environment" in thread) || !thread.environment) {
    throw new RepositoryUnavailableError("This thread has no active project environment.");
  }

  const environment = thread.environment;
  if (!environment.path) {
    throw new RepositoryUnavailableError("The thread environment has no workspace path yet.");
  }
  if (environment.status !== "ready") {
    throw new RepositoryUnavailableError(`The thread environment is ${environment.status}.`);
  }

  return {
    hostId: environment.hostId,
    environmentPath: environment.path,
  };
}

export default function plugin(bb: BbPluginApi) {
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const watchedThreads = new Map<string, number>();
  const threadEnvironments = new Map<string, string | null>();
  const refreshes = createRefreshScheduler((threadId) => {
    bb.rpc.experimental_invalidate([threadHistoryTag(threadId)]);
  });
  let stopEvents: (() => void) | null = null;

  function subscribeToChanges(): () => void {
    const stopThreads = bb.sdk.subscribe({
      event: "thread:changed",
      callback: (event) => {
        const threadId = event.id;
        if (threadId === undefined || !watchedThreads.has(threadId)) return;
        if (event.changes.includes("environment-changed")) {
          void loadThreadEnvironment(threadId);
          refreshes.request(threadId, "urgent");
          return;
        }
        const status = event.metadata?.statusChange?.status;
        if (
          event.changes.includes("status-changed")
          && (status === "idle" || status === "error")
        ) {
          refreshes.request(threadId, "urgent");
        }
      },
    });
    const stopEnvironments = bb.sdk.subscribe({
      event: "environment:changed",
      callback: (event) => {
        if (event.id === undefined) return;
        const urgency = event.changes.some((change) => URGENT_ENVIRONMENT_CHANGES.has(change))
          ? "urgent"
          : "work-status";
        for (const [threadId, environmentId] of threadEnvironments) {
          if (environmentId === event.id && watchedThreads.has(threadId)) {
            refreshes.request(threadId, urgency);
          }
        }
      },
    });
    return () => {
      stopThreads();
      stopEnvironments();
    };
  }

  async function loadThreadEnvironment(threadId: string): Promise<void> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      if (watchedThreads.has(threadId)) {
        threadEnvironments.set(threadId, thread.environmentId);
      }
    } catch {
      threadEnvironments.delete(threadId);
    }
  }

  function watchThread(threadId: string, signal: AbortSignal): void {
    const watchers = watchedThreads.get(threadId) ?? 0;
    watchedThreads.set(threadId, watchers + 1);
    stopEvents ??= subscribeToChanges();
    if (watchers === 0) void loadThreadEnvironment(threadId);
    signal.addEventListener(
      "abort",
      () => {
        const remaining = (watchedThreads.get(threadId) ?? 1) - 1;
        if (remaining > 0) {
          watchedThreads.set(threadId, remaining);
          return;
        }
        watchedThreads.delete(threadId);
        threadEnvironments.delete(threadId);
        refreshes.forget(threadId);
        if (watchedThreads.size > 0) return;
        stopEvents?.();
        stopEvents = null;
      },
      { once: true },
    );
  }

  bb.settings.define({
    showHeaderShortcut: {
      type: "boolean",
      label: "Show thread header shortcut",
      description: "Show Git History beside the editor controls. Git History remains available from New tab.",
      default: false,
    },
    experimentalCommitGraph: {
      type: "boolean",
      label: "Experimental commit graph",
      description: "Show branch and merge lanes in Git History.",
      default: true,
    },
  });

  bb.rpc.register(rpcContract, {
    async repositories({ threadId }) {
      try {
        const target = await repositoryForThread(bb, threadId);
        const result = await host.call(
          "repositories",
          { environmentPath: target.environmentPath },
          { hostId: target.hostId },
        );
        return { ...result, unavailableReason: null };
      } catch (error) {
        if (!(error instanceof RepositoryUnavailableError)) throw error;
        return {
          repositories: [],
          unavailableReason: error.message,
        };
      }
    },

    async history({ threadId, repositoryKey, offset, limit }) {
      try {
        const target = await repositoryForThread(bb, threadId);
        return await host.call(
          "history",
          { ...repositoryInput(target, repositoryKey), offset, limit },
          { hostId: target.hostId },
        );
      } catch (error) {
        if (!(error instanceof RepositoryUnavailableError)) throw error;
        return {
          repoName: "Git history",
          currentBranch: null,
          uncommittedFiles: [],
          commits: [],
          offset,
          total: 0,
          hasMore: false,
          revision: "",
          unavailableReason: error.message,
        };
      }
    },

    async historyRevision({ threadId, repositoryKey }) {
      try {
        const target = await repositoryForThread(bb, threadId);
        return await host.call(
          "historyRevision",
          repositoryInput(target, repositoryKey),
          { hostId: target.hostId },
        );
      } catch (error) {
        if (!(error instanceof RepositoryUnavailableError)) throw error;
        return {
          revision: "",
          unavailableReason: error.message,
        };
      }
    },

    async details({ threadId, repositoryKey, hash }) {
      const target = await repositoryForThread(bb, threadId);
      return host.call(
        "details",
        { ...repositoryInput(target, repositoryKey), hash },
        { hostId: target.hostId },
      );
    },

    async patch({ threadId, repositoryKey, hash, path }) {
      const target = await repositoryForThread(bb, threadId);
      return host.call(
        "patch",
        { ...repositoryInput(target, repositoryKey), hash, path },
        { hostId: target.hostId },
      );
    },

    async workingPatch({ threadId, repositoryKey, path }) {
      const target = await repositoryForThread(bb, threadId);
      return host.call(
        "workingPatch",
        { ...repositoryInput(target, repositoryKey), path },
        { hostId: target.hostId },
      );
    },
  });

  for (const method of ["repositories", "historyRevision"] as const) {
    bb.rpc.experimental_whileWatched(method, (read, signal) => {
      if (!("input" in read)) return;
      const parsed = rpcContract[method].input.safeParse(read.input);
      if (parsed.success) watchThread(parsed.data.threadId, signal);
    });
  }

  bb.onDispose(() => {
    stopEvents?.();
    stopEvents = null;
    watchedThreads.clear();
    threadEnvironments.clear();
    refreshes.dispose();
  });

  bb.log.info("Git History loaded");
}
