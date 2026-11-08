import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  createFakePluginHost,
  makeThreadResponse,
} from "@get-bb/plugin-sdk/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { threadHistoryTag, type HistoryPage } from "./contracts";
import {
  URGENT_REFRESH_DELAY_MS,
  WORK_STATUS_REFRESH_INTERVAL_MS,
} from "./refresh-scheduler";
import plugin from "./server";

describe("Git history server", () => {
  it("checks the host when cached environment metadata says non-Git", async () => {
    const thread = {
      ...makeThreadResponse({
        id: "thread-1",
        projectId: "project-1",
        environmentId: "environment-1",
      }),
      environment: {
        id: "environment-1",
        projectId: "project-1",
        hostId: "host-1",
        name: null,
        path: "/workspace/plain-folder",
        branchName: null,
        baseBranch: null,
        defaultBranch: null,
        mergeBaseBranch: null,
        isGitRepo: false,
        isWorktree: false,
        managed: false,
        status: "ready" as const,
        workspaceProvisionType: "unmanaged" as const,
        createdAt: 1,
        updatedAt: 1,
      },
    };
    const historyPage: HistoryPage = {
      repoName: "late-init-repo",
      currentBranch: "main",
      uncommittedFiles: [],
      commits: [],
      offset: 0,
      total: 0,
      hasMore: false,
      revision: "abc123\0main\0",
      unavailableReason: null,
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "git-history",
      sdk: {
        threads: {
          get: async () => thread,
        },
      },
      experimental_callHostRpc: async ({ method }) => method === "workingPatch"
        ? { path: "README.md", patch: "@@ -1 +1,2 @@", truncated: false }
        : historyPage,
    });
    plugin(bb);

    expect(harness.registrations.settingsDescriptors.showHeaderShortcut).toEqual({
      type: "boolean",
      label: "Show thread header shortcut",
      description: "Show Git History beside the editor controls. Git History remains available from New tab.",
      default: false,
    });
    expect(harness.registrations.settingsDescriptors.experimentalCommitGraph).toEqual({
      type: "boolean",
      label: "Experimental commit graph",
      description: "Show branch and merge lanes in Git History.",
      default: true,
    });

    const result = (await harness.behavior.callRpc("history", {
      threadId: "thread-1",
      offset: 0,
      limit: 200,
    })) as HistoryPage;

    expect(result.repoName).toBe("late-init-repo");
    expect(result.currentBranch).toBe("main");
    expect(result.unavailableReason).toBeNull();
    expect(result.commits).toEqual([]);
    expect(harness.inspection.experimental_hostRpcCalls).toEqual([
      {
        method: "history",
        hostId: "host-1",
        input: {
          environmentPath: "/workspace/plain-folder",
          offset: 0,
          limit: 200,
        },
      },
    ]);

    const patch = await harness.behavior.callRpc("workingPatch", {
      threadId: "thread-1",
      path: "README.md",
    });

    expect(patch).toEqual({
      path: "README.md",
      patch: "@@ -1 +1,2 @@",
      truncated: false,
    });
    expect(harness.inspection.experimental_hostRpcCalls.at(-1)).toEqual({
      method: "workingPatch",
      hostId: "host-1",
      input: {
        environmentPath: "/workspace/plain-folder",
        path: "README.md",
      },
    });

    await harness.lifecycle.dispose();
  });

  it("routes repository discovery and every data RPC to the thread environment host", async () => {
    const hash = "a1b2c3d4";
    const thread = {
      ...makeThreadResponse({
        id: "thread-1",
        projectId: "project-1",
        environmentId: "environment-1",
      }),
      environment: {
        id: "environment-1",
        projectId: "project-1",
        hostId: "host-1",
        name: null,
        path: "/workspace/root",
        branchName: null,
        baseBranch: null,
        defaultBranch: null,
        mergeBaseBranch: null,
        isGitRepo: false,
        isWorktree: false,
        managed: false,
        status: "ready" as const,
        workspaceProvisionType: "unmanaged" as const,
        createdAt: 1,
        updatedAt: 1,
      },
    };
    const historyPage: HistoryPage = {
      repoName: "api",
      currentBranch: "main",
      uncommittedFiles: [],
      commits: [],
      offset: 0,
      total: 0,
      hasMore: false,
      revision: "revision-1",
      unavailableReason: null,
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "git-history",
      sdk: {
        threads: {
          get: async () => thread,
        },
      },
      experimental_callHostRpc: async ({ input, method }) => {
        if ((input as { repositoryKey?: string }).repositoryKey === "/tmp/other") {
          throw new Error("repository selection rejected at host boundary");
        }
        switch (method) {
          case "repositories":
            return {
              repositories: [
                { key: "repos/api", name: "api" },
                { key: "repos/web", name: "web" },
              ],
            };
          case "historyRevision":
            return { revision: "revision-1", unavailableReason: null };
          case "details":
            return {
              hash,
              parents: [],
              authorName: "Ada Lovelace",
              authorEmail: "ada@example.com",
              authorDate: "2026-09-10T00:00:00.000Z",
              committerDate: "2026-09-10T00:00:00.000Z",
              subject: "Add repository routing",
              refs: [],
              body: "",
              files: [],
            };
          case "patch":
          case "workingPatch":
            return { path: "README.md", patch: "@@ -1 +1 @@", truncated: false };
          default:
            return historyPage;
        }
      },
    });
    plugin(bb);

    await expect(harness.behavior.callRpc("repositories", { threadId: "thread-1" })).resolves.toEqual({
      repositories: [
        { key: "repos/api", name: "api" },
        { key: "repos/web", name: "web" },
      ],
      unavailableReason: null,
    });
    await harness.behavior.callRpc("history", {
      threadId: "thread-1",
      repositoryKey: "repos/api",
      offset: 0,
      limit: 200,
    });
    await harness.behavior.callRpc("historyRevision", {
      threadId: "thread-1",
      repositoryKey: "repos/api",
    });
    await harness.behavior.callRpc("details", {
      threadId: "thread-1",
      repositoryKey: "repos/api",
      hash,
    });
    await harness.behavior.callRpc("patch", {
      threadId: "thread-1",
      repositoryKey: "repos/api",
      hash,
      path: "README.md",
    });
    await harness.behavior.callRpc("workingPatch", {
      threadId: "thread-1",
      repositoryKey: "repos/api",
      path: "README.md",
    });

    expect(harness.inspection.experimental_hostRpcCalls).toContainEqual({
      method: "repositories",
      hostId: "host-1",
      input: { environmentPath: "/workspace/root" },
    });
    expect(harness.inspection.experimental_hostRpcCalls).toContainEqual({
      method: "history",
      hostId: "host-1",
      input: {
        environmentPath: "/workspace/root",
        repositoryKey: "repos/api",
        offset: 0,
        limit: 200,
      },
    });
    expect(harness.inspection.experimental_hostRpcCalls).toContainEqual({
      method: "historyRevision",
      hostId: "host-1",
      input: {
        environmentPath: "/workspace/root",
        repositoryKey: "repos/api",
      },
    });
    expect(harness.inspection.experimental_hostRpcCalls).toContainEqual({
      method: "details",
      hostId: "host-1",
      input: {
        environmentPath: "/workspace/root",
        repositoryKey: "repos/api",
        hash,
      },
    });
    expect(harness.inspection.experimental_hostRpcCalls).toContainEqual({
      method: "patch",
      hostId: "host-1",
      input: {
        environmentPath: "/workspace/root",
        repositoryKey: "repos/api",
        hash,
        path: "README.md",
      },
    });
    expect(harness.inspection.experimental_hostRpcCalls).toContainEqual({
      method: "workingPatch",
      hostId: "host-1",
      input: {
        environmentPath: "/workspace/root",
        repositoryKey: "repos/api",
        path: "README.md",
      },
    });

    await expect(harness.behavior.callRpc("history", {
      threadId: "thread-1",
      repositoryKey: "/tmp/other",
      offset: 0,
      limit: 200,
    })).rejects.toThrow(/host boundary/);
    expect(harness.inspection.experimental_hostRpcCalls.at(-1)).toEqual({
      method: "history",
      hostId: "host-1",
      input: {
        environmentPath: "/workspace/root",
        repositoryKey: "/tmp/other",
        offset: 0,
        limit: 200,
      },
    });

    await harness.lifecycle.dispose();
  });

  it("returns unavailable payloads when a thread has no ready environment", async () => {
    const missingEnvironment = makeThreadResponse({
      id: "thread-missing",
      projectId: "project-1",
      environmentId: null,
    });
    const unreadyEnvironment = {
      ...makeThreadResponse({
        id: "thread-provisioning",
        projectId: "project-1",
        environmentId: "environment-1",
      }),
      environment: {
        id: "environment-1",
        projectId: "project-1",
        hostId: "host-1",
        name: null,
        path: "/workspace/root",
        branchName: null,
        baseBranch: null,
        defaultBranch: null,
        mergeBaseBranch: null,
        isGitRepo: false,
        isWorktree: false,
        managed: false,
        status: "provisioning" as const,
        workspaceProvisionType: "unmanaged" as const,
        createdAt: 1,
        updatedAt: 1,
      },
    };
    const { bb, harness } = createFakePluginHost({
      pluginId: "git-history",
      sdk: {
        threads: {
          get: async ({ threadId }) => threadId === "thread-missing"
            ? missingEnvironment
            : unreadyEnvironment,
        },
      },
    });
    plugin(bb);

    for (const threadId of ["thread-missing", "thread-provisioning"]) {
      await expect(harness.behavior.callRpc("repositories", { threadId })).resolves.toEqual(
        expect.objectContaining({ unavailableReason: expect.any(String) }),
      );
      await expect(harness.behavior.callRpc("history", {
        threadId,
        offset: 0,
        limit: 200,
      })).resolves.toEqual(expect.objectContaining({ unavailableReason: expect.any(String) }));
      await expect(harness.behavior.callRpc("historyRevision", { threadId })).resolves.toEqual(
        expect.objectContaining({ unavailableReason: expect.any(String) }),
      );
    }
    expect(harness.inspection.experimental_hostRpcCalls).toEqual([]);

    await harness.lifecycle.dispose();
  });

  describe("refreshing watched history", () => {
    type Subscription = Parameters<BbPluginApi["sdk"]["subscribe"]>[0];

    afterEach(() => {
      vi.useRealTimers();
    });

    async function watchedHistoryHarness() {
      vi.useFakeTimers();
      const subscriptions = new Set<Subscription>();
      const environments: Record<string, string> = {
        "thread-1": "environment-1",
        "thread-2": "environment-2",
      };
      const fake = createFakePluginHost({
        pluginId: "git-history",
        sdk: {
          threads: {
            get: async ({ threadId }: { threadId: string }) =>
              makeThreadResponse({
                id: threadId,
                projectId: "project-1",
                environmentId: environments[threadId] ?? null,
              }),
          },
          subscribe: (subscription: Subscription) => {
            subscriptions.add(subscription);
            return () => subscriptions.delete(subscription);
          },
        },
      });
      plugin(fake.bb);
      const emit = async (
        event: "thread:changed" | "environment:changed",
        payload: object,
      ) => {
        for (const subscription of subscriptions) {
          if (subscription.event !== event) continue;
          (subscription.callback as (payload: object) => void)(payload);
        }
        await vi.advanceTimersByTimeAsync(URGENT_REFRESH_DELAY_MS);
      };
      const invalidations = () => fake.harness.inspection.experimental_rpcInvalidations;
      return { fake, subscriptions, emit, invalidations };
    }

    it("invalidates a watched thread when its turn ends or its environment's refs change", async () => {
      const { fake, emit, invalidations } = await watchedHistoryHarness();
      fake.harness.experimental_watchRpc("historyRevision", {
        input: { threadId: "thread-1", repositoryKey: "." },
      });
      await vi.advanceTimersByTimeAsync(0);

      await emit("thread:changed", {
        id: "thread-1",
        changes: ["status-changed"],
        metadata: { statusChange: { status: "idle" } },
      });
      expect(invalidations()).toEqual([[threadHistoryTag("thread-1")]]);

      await emit("environment:changed", { id: "environment-1", changes: ["git-refs-changed"] });
      expect(invalidations()).toHaveLength(2);

      await emit("thread:changed", {
        id: "thread-2",
        changes: ["status-changed"],
        metadata: { statusChange: { status: "idle" } },
      });
      await emit("environment:changed", { id: "environment-2", changes: ["git-refs-changed"] });
      await emit("thread:changed", {
        id: "thread-1",
        changes: ["status-changed"],
        metadata: { statusChange: { status: "running" } },
      });
      expect(invalidations()).toHaveLength(2);
      await fake.harness.lifecycle.dispose();
    });

    it("refreshes working-tree edits no more than once per interval", async () => {
      const { fake, emit, invalidations } = await watchedHistoryHarness();
      fake.harness.experimental_watchRpc("repositories", { input: { threadId: "thread-1" } });
      await vi.advanceTimersByTimeAsync(0);

      for (let edit = 0; edit < 20; edit += 1) {
        await emit("environment:changed", { id: "environment-1", changes: ["work-status-changed"] });
      }
      expect(invalidations()).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(WORK_STATUS_REFRESH_INTERVAL_MS);
      expect(invalidations()).toHaveLength(2);
      await fake.harness.lifecycle.dispose();
    });

    it("listens for changes only while a client watches", async () => {
      const { fake, subscriptions, emit, invalidations } = await watchedHistoryHarness();
      expect(subscriptions.size).toBe(0);

      const stopRepositories = fake.harness.experimental_watchRpc("repositories", {
        input: { threadId: "thread-1" },
      });
      const stopRevision = fake.harness.experimental_watchRpc("historyRevision", {
        input: { threadId: "thread-1", repositoryKey: "." },
      });
      expect(subscriptions.size).toBe(2);
      stopRepositories();
      expect(subscriptions.size).toBe(2);
      stopRevision();
      expect(subscriptions.size).toBe(0);

      await emit("environment:changed", { id: "environment-1", changes: ["git-refs-changed"] });
      expect(invalidations()).toEqual([]);

      fake.harness.experimental_watchRpc("repositories", { input: { threadId: "thread-1" } });
      await fake.harness.lifecycle.dispose();
      expect(subscriptions.size).toBe(0);
    });
  });
});
