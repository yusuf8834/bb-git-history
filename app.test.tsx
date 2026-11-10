// @vitest-environment jsdom

import { fireEvent, waitFor } from "@testing-library/react";
import {
  loadPluginApp,
  renderSlot,
  type CapturedPluginApp,
} from "@get-bb/plugin-sdk/testing/app";
import type {
  BbNavigate,
  ExperimentalPanelController,
  ExperimentalTabRegistration,
  ExperimentalThreadTabProps,
  JsonValue,
  PluginBrowserBbSdk,
} from "@get-bb/plugin-sdk/app";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHistoryHeaderButton, gitHistoryHeaderAction, registerHeaderShortcut } from "./app";
import {
  rpcContract,
  threadHistoryTag,
  type CommitDetails,
  type HistoryPage,
  type RepositoryDescriptor,
} from "./contracts";

const hash = "1234567890abcdef1234567890abcdef12345678";
const parentHash = "abcdef1234567890abcdef1234567890abcdef12";
const historyPage: HistoryPage = {
  repoName: "example-repo",
  currentBranch: "main",
  uncommittedFiles: [],
  commits: [
    {
      hash,
      parents: [parentHash, "fedcba0987654321fedcba0987654321fedcba09"],
      authorName: "History Test",
      authorEmail: "history@example.com",
      authorDate: "2026-01-02T03:04:05Z",
      committerDate: "2026-01-02T03:04:05Z",
      subject: "feat: render commit details",
      refs: [
        {
          fullName: "refs/heads/main",
          name: "main",
          kind: "local",
          isHead: true,
        },
      ],
    },
  ],
  offset: 0,
  total: 1,
  hasMore: false,
  revision: "revision-1",
  unavailableReason: null,
};

const commitDetails: CommitDetails = {
  ...historyPage.commits[0]!,
  body: "A longer explanation of the change.\n\nWith a second paragraph.",
  files: [
    {
      path: "src/example.ts",
      status: "modified",
      additions: 2,
      deletions: 1,
    },
  ],
};

function rpcHandlers() {
  return {
    repositories: async () => ({
      repositories: [{ key: "repos/api", name: "API" }],
      unavailableReason: null,
    }),
    history: async () => historyPage,
    historyRevision: async () => ({ revision: "revision-1", unavailableReason: null }),
    details: async () => commitDetails,
    patch: async () => ({
      path: "src/example.ts",
      patch: "@@ -1 +1 @@\n-old\n+new",
      truncated: false,
    }),
    workingPatch: async ({ path }: { path: string }) => ({
      path,
      patch: "",
      truncated: false,
    }),
  };
}

function historyFor(repositoryKey: string): HistoryPage {
  const name = repositoryKey === "repos/web" ? "Web" : "API";
  return {
    ...historyPage,
    repoName: name,
    commits: historyPage.commits.map((commit) => ({
      ...commit,
      subject: `${name} history`,
    })),
    uncommittedFiles: [
      {
        path: "src/working.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
      },
    ],
  };
}

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve: resolve! };
}

type HistoryTabProps = ExperimentalThreadTabProps & { params: JsonValue | null };

let app: CapturedPluginApp;

type HistoryTabRegistration = Extract<
  ExperimentalTabRegistration,
  { context: { kind: "thread" }; availability: "action" }
>;

function historyTab(): { component: HistoryTabRegistration["component"] } {
  const tab = app.tabs.find(
    (candidate): candidate is HistoryTabRegistration =>
      candidate.context.kind === "thread" && candidate.availability === "action",
  );
  if (tab === undefined) throw new Error("Git History must register a thread action tab");
  return { component: tab.component };
}

beforeAll(async () => {
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get: () => 600,
  });
  Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
    configurable: true,
    get: () => 600,
  });
  app = await loadPluginApp(() => import("./app"));
});

beforeEach(() => {
  window.localStorage.clear();
});

describe("Git history app", () => {
  it("registers the history tab and the icon header shortcut", () => {
    expect(app.tabs.map((tab) => [tab.id, tab.context, tab.availability])).toEqual([
      ["history", { kind: "thread" }, "action"],
    ]);
    const legacy = app as unknown as {
      threadHeaderActions: { id: string; title: string; component: unknown }[];
    };
    expect(legacy.threadHeaderActions).toEqual([
      { id: "git-history", title: "Git History", component: GitHistoryHeaderButton },
    ]);
    expect(app.threadActions.some((action) => action.id === "git-history")).toBe(false);
  });

  it("falls back to the labelled header action when bb lacks the icon slot", () => {
    const experimental_threadAction = vi.fn();
    expect(registerHeaderShortcut({ experimental_threadAction })).toBe("labelled");
    expect(experimental_threadAction).toHaveBeenCalledWith(gitHistoryHeaderAction);

    const experimental_threadHeaderAction = vi.fn();
    const slots = { experimental_threadAction: vi.fn(), experimental_threadHeaderAction };
    expect(registerHeaderShortcut(slots)).toBe("icon");
    expect(experimental_threadHeaderAction).toHaveBeenCalledOnce();
    expect(slots.experimental_threadAction).not.toHaveBeenCalled();
  });

  it("opens the history tab from the labelled header action", () => {
    const headerAction = gitHistoryHeaderAction;
    expect(headerAction.placement).toBe("header");

    const openTab = vi.fn<ExperimentalPanelController["openTab"]>(() => true);
    const input = {
      thread: { id: "thread-1" } as Parameters<typeof headerAction.item>[0]["thread"],
      sdk: {} as PluginBrowserBbSdk,
      navigate: {} as BbNavigate,
      experimental_panel: { openTab } as unknown as ExperimentalPanelController,
    };
    expect(headerAction.item({ ...input, data: false })).toBeNull();

    const action = headerAction.item({ ...input, data: true });
    expect(action?.label).toBe("Git History");
    void action?.run({ requestRename: () => undefined });
    expect(openTab).toHaveBeenCalledWith({
      tab: { id: "history", context: { kind: "thread" }, availability: "action" },
      title: "Git History",
    });
  });

  it("shows the icon header button only with the shortcut setting on", () => {
    const hidden = renderSlot({ component: GitHistoryHeaderButton }, {}, { settings: {} });
    expect(hidden.queryByRole("button", { name: "Open Git history" })).toBeNull();
    hidden.unmount();

    const shown = renderSlot(
      { component: GitHistoryHeaderButton },
      {},
      { settings: { showHeaderShortcut: true } },
    );
    fireEvent.click(shown.getByRole("button", { name: "Open Git history" }));
    expect(shown.experimental_panelCalls).toEqual([
      {
        method: "openTab",
        options: {
          tab: { id: "history", context: { kind: "thread" }, availability: "action" },
          title: "Git History",
        },
      },
    ]);
  });

  it("renders default experimental lanes and expanded commit details", async () => {
    const panel = renderSlot<HistoryTabProps, typeof rpcContract>(
      historyTab(),
      { threadId: "thread-1", environment: null, params: null },
      {
        settings: {},
        experimental_rpcContract: rpcContract,
        rpc: rpcHandlers(),
      },
    );

    await panel.findByText("example-repo / main");
    const commitButton = await panel.findByRole("button", {
      name: /render commit details/,
    });
    expect(panel.container.querySelector(".git-graph-cell")).not.toBeNull();

    fireEvent.click(commitButton);
    await panel.findByText("A longer explanation of the change.", { exact: false });
    expect(panel.getByTitle(hash).textContent).toBe(hash);
    expect(panel.container.querySelector(".git-expansion-graph")).not.toBeNull();
    expect(panel.inspection.rpcCalls).toContainEqual({
      method: "details",
      input: { threadId: "thread-1", repositoryKey: "repos/api", hash },
    });
    panel.lifecycle.unmount();
  });

  it("keeps the native repository selector hidden for one repository", async () => {
    const panel = renderSlot<HistoryTabProps, typeof rpcContract>(
      historyTab(),
      { threadId: "thread-1", environment: null, params: null },
      { settings: {}, experimental_rpcContract: rpcContract, rpc: rpcHandlers() },
    );

    await panel.findByText("example-repo / main");
    expect(panel.queryByLabelText("Repository")).toBeNull();
    expect(panel.inspection.rpcCalls).toContainEqual({
      method: "history",
      input: {
        threadId: "thread-1",
        repositoryKey: "repos/api",
        offset: 0,
        limit: 200,
      },
    });
    panel.lifecycle.unmount();
  });

  it("selects the first repository without rendering the unavailable state", async () => {
    const setAttribute = vi.spyOn(Element.prototype, "setAttribute");
    const panel = renderSlot<HistoryTabProps, typeof rpcContract>(
      historyTab(),
      { threadId: "thread-1", environment: null, params: null },
      { settings: {}, experimental_rpcContract: rpcContract, rpc: rpcHandlers() },
    );

    await panel.findByText("example-repo / main");
    const renderedAlerts = setAttribute.mock.calls.filter(
      ([name, value]) => name === "role" && value === "alert",
    );
    setAttribute.mockRestore();
    expect(renderedAlerts).toEqual([]);
    panel.lifecycle.unmount();
  });

  it("scopes history, details, and patches to the selected repository", async () => {
    const repositories: RepositoryDescriptor[] = [
      { key: "repos/api", name: "API", currentBranch: "main", dirtyCount: 0 },
      { key: "repos/web", name: "Web", currentBranch: "feature/ui", dirtyCount: 1 },
    ];
    const panel = renderSlot<HistoryTabProps, typeof rpcContract>(
      historyTab(),
      { threadId: "thread-1", environment: null, params: null },
      {
        settings: {},
        experimental_rpcContract: rpcContract,
        rpc: {
          ...rpcHandlers(),
          repositories: async () => ({ repositories, unavailableReason: null }),
          history: async ({ repositoryKey }: { repositoryKey?: string }) =>
            historyFor(repositoryKey ?? "repos/api"),
          details: async () => ({
            ...commitDetails,
            subject: "Web history",
          }),
          patch: async () => ({
            path: "src/example.ts",
            patch: "",
            truncated: false,
          }),
        },
      },
    );

    const webRepository = await panel.findByRole("button", { name: "Show Web history" });
    expect(panel.getByText("feature/ui")).toBeTruthy();
    expect(panel.getByText("1 change")).toBeTruthy();
    fireEvent.click(webRepository);
    await panel.findByRole("button", { name: /^Web history/ });
    expect(panel.inspection.rpcCalls).toContainEqual({
      method: "history",
      input: {
        threadId: "thread-1",
        repositoryKey: "repos/web",
        offset: 0,
        limit: 200,
      },
    });

    fireEvent.click(panel.getByRole("button", { name: /^Web history/ }));
    await panel.findByText("A longer explanation of the change.", { exact: false });
    expect(panel.inspection.rpcCalls).toContainEqual({
      method: "details",
      input: { threadId: "thread-1", repositoryKey: "repos/web", hash },
    });

    fireEvent.click(panel.getByTitle("Open diff for src/example.ts"));
    await panel.findByText("No textual diff for this file.");
    expect(panel.inspection.rpcCalls).toContainEqual({
      method: "patch",
      input: {
        threadId: "thread-1",
        repositoryKey: "repos/web",
        hash,
        path: "src/example.ts",
      },
    });

    fireEvent.click(panel.getByRole("button", { name: "Back to Git history" }));
    fireEvent.click(panel.getByRole("button", { name: /Uncommitted/ }));
    fireEvent.click(panel.getByTitle("Open uncommitted diff for src/working.ts"));
    await panel.findByText("No textual diff for this file.");
    expect(panel.inspection.rpcCalls).toContainEqual({
      method: "workingPatch",
      input: {
        threadId: "thread-1",
        repositoryKey: "repos/web",
        path: "src/working.ts",
      },
    });
    panel.lifecycle.unmount();
  });

  it("remembers the selected repository for the thread", async () => {
    const repositories: RepositoryDescriptor[] = [
      { key: "repos/api", name: "API", currentBranch: "main", dirtyCount: 0 },
      { key: "repos/web", name: "Web", currentBranch: "feature/ui", dirtyCount: 0 },
    ];
    const options = {
      settings: {},
      experimental_rpcContract: rpcContract,
      rpc: {
        ...rpcHandlers(),
        repositories: async () => ({ repositories, unavailableReason: null }),
        history: async ({ repositoryKey }: { repositoryKey?: string }) =>
          historyFor(repositoryKey ?? "repos/api"),
      },
    };
    const firstPanel = renderSlot<HistoryTabProps, typeof rpcContract>(
      historyTab(),
      { threadId: "remembered-thread", environment: null, params: null },
      options,
    );

    fireEvent.click(await firstPanel.findByRole("button", { name: "Show Web history" }));
    await firstPanel.findByRole("button", { name: /^Web history/ });
    firstPanel.lifecycle.unmount();

    const reopenedPanel = renderSlot<HistoryTabProps, typeof rpcContract>(
      historyTab(),
      { threadId: "remembered-thread", environment: null, params: null },
      options,
    );
    await reopenedPanel.findByRole("button", { name: /^Web history/ });
    expect(reopenedPanel.getByRole("button", { name: "Show Web history" })
      .getAttribute("aria-pressed")).toBe("true");
    reopenedPanel.lifecycle.unmount();
  });

  it("filters a constrained repository list when the workspace is large", async () => {
    const repositories: RepositoryDescriptor[] = Array.from({ length: 12 }, (_, index) => ({
      key: `repos/service-${index}`,
      name: `service-${index}`,
      currentBranch: "main",
      dirtyCount: index,
    }));
    const panel = renderSlot<HistoryTabProps, typeof rpcContract>(
      historyTab(),
      { threadId: "large-thread", environment: null, params: null },
      {
        settings: {},
        experimental_rpcContract: rpcContract,
        rpc: {
          ...rpcHandlers(),
          repositories: async () => ({ repositories, unavailableReason: null }),
          history: async ({ repositoryKey }: { repositoryKey?: string }) =>
            historyFor(repositoryKey ?? repositories[0]!.key),
        },
      },
    );

    const search = await panel.findByRole("searchbox", { name: "Search repositories" });
    fireEvent.change(search, { target: { value: "service-11" } });
    expect(panel.getByRole("button", { name: "Show service-11 history" })).toBeTruthy();
    expect(panel.queryByRole("button", { name: "Show service-1 history" })).toBeNull();
    expect(panel.container.querySelector(".git-repository-list")).not.toBeNull();
    fireEvent.click(panel.getByRole("button", { name: "Collapse repositories" }));
    expect(panel.queryByRole("searchbox", { name: "Search repositories" })).toBeNull();
    fireEvent.click(panel.getByRole("button", { name: "Expand repositories" }));
    expect(panel.getByRole("searchbox", { name: "Search repositories" })).toBeTruthy();
    panel.lifecycle.unmount();
  });

  it("keeps an active repository search clearable after the list shrinks", async () => {
    let repositories: RepositoryDescriptor[] = Array.from({ length: 9 }, (_, index) => ({
      key: `repos/service-${index}`,
      name: `service-${index}`,
      currentBranch: "main",
      dirtyCount: 0,
    }));
    const panel = renderSlot<HistoryTabProps, typeof rpcContract>(
      historyTab(),
      { threadId: "shrinking-thread", environment: null, params: null },
      {
        settings: {},
        experimental_rpcContract: rpcContract,
        rpc: {
          ...rpcHandlers(),
          repositories: async () => ({ repositories, unavailableReason: null }),
        },
      },
    );

    try {
      await panel.findByText("example-repo / main");
      fireEvent.change(panel.getByRole("searchbox", { name: "Search repositories" }), {
        target: { value: "service-8" },
      });
      repositories = repositories.slice(0, 8);
      fireEvent.click(panel.getByRole("button", { name: "Refresh Git history" }));
      await panel.findByText("No matching repositories.");

      fireEvent.change(panel.getByRole("searchbox", { name: "Search repositories" }), {
        target: { value: "" },
      });
      expect(panel.queryByRole("searchbox", { name: "Search repositories" })).toBeNull();
      for (const repository of repositories) {
        expect(panel.getByRole("button", { name: `Show ${repository.name} history` })).toBeTruthy();
      }
    } finally {
      panel.lifecycle.unmount();
    }
  });

  it("does not render a late previous-repository history response after switching", async () => {
    const apiHistory = deferred<HistoryPage>();
    const panel = renderSlot<HistoryTabProps, typeof rpcContract>(
      historyTab(),
      { threadId: "thread-1", environment: null, params: null },
      {
        settings: {},
        experimental_rpcContract: rpcContract,
        rpc: {
          ...rpcHandlers(),
          repositories: async () => ({
            repositories: [
              { key: "repos/api", name: "API" },
              { key: "repos/web", name: "Web" },
            ],
            unavailableReason: null,
          }),
          history: async ({ repositoryKey }: { repositoryKey?: string }) =>
            repositoryKey === "repos/web"
              ? historyFor("repos/web")
              : apiHistory.promise,
        },
      },
    );

    fireEvent.click(await panel.findByRole("button", { name: "Show Web history" }));
    await panel.findByRole("button", { name: /^Web history/ });
    apiHistory.resolve(historyFor("repos/api"));
    await Promise.resolve();

    expect(panel.getByRole("button", { name: /^Web history/ })).toBeTruthy();
    expect(panel.queryByRole("button", { name: /^API history/ })).toBeNull();
    panel.lifecycle.unmount();
  });

  it("requires a new selection when the selected repository disappears on refresh", async () => {
    let discoveryCalls = 0;
    const panel = renderSlot<HistoryTabProps, typeof rpcContract>(
      historyTab(),
      { threadId: "thread-1", environment: null, params: null },
      {
        settings: {},
        experimental_rpcContract: rpcContract,
        rpc: {
          ...rpcHandlers(),
          repositories: async () => {
            discoveryCalls += 1;
            return {
              repositories: discoveryCalls === 1
                ? [
                  { key: "repos/api", name: "API" },
                  { key: "repos/web", name: "Web" },
                ]
                : [{ key: "repos/api", name: "API" }],
              unavailableReason: null,
            };
          },
          history: async ({ repositoryKey }: { repositoryKey?: string }) =>
            historyFor(repositoryKey ?? "repos/api"),
        },
      },
    );

    fireEvent.click(await panel.findByRole("button", { name: "Show Web history" }));
    await panel.findByRole("button", { name: /^Web history/ });
    fireEvent.click(panel.getByRole("button", { name: "Refresh Git history" }));

    await panel.findByText("The selected repository is no longer available.");
    expect(panel.queryByRole("button", { name: /^Web history/ })).toBeNull();
    fireEvent.click(panel.getByRole("button", { name: "Show API history" }));
    await panel.findByRole("button", { name: /^API history/ });
    panel.lifecycle.unmount();
  });

  it("reloads history only when an invalidation reports a new revision", async () => {
    let revision = "revision-1";
    const panel = renderSlot<HistoryTabProps, typeof rpcContract>(
      historyTab(),
      { threadId: "thread-1", environment: null, params: null },
      {
        settings: {},
        experimental_rpcContract: rpcContract,
        rpc: {
          ...rpcHandlers(),
          history: async () => ({
            ...historyPage,
            revision,
            commits: historyPage.commits.map((commit) => ({
              ...commit,
              subject: `subject at ${revision}`,
            })),
          }),
          historyRevision: async () => ({ revision, unavailableReason: null }),
        },
      },
    );
    const historyCalls = () =>
      panel.inspection.rpcCalls.filter((call) => call.method === "history").length;
    const revisionCalls = () =>
      panel.inspection.rpcCalls.filter((call) => call.method === "historyRevision").length;

    await panel.findByRole("button", { name: /subject at revision-1/ });
    await waitFor(() => expect(revisionCalls()).toBe(1));
    const loadsBeforeInvalidation = historyCalls();

    await panel.experimental_invalidateRpc([threadHistoryTag("thread-1")]);
    await waitFor(() => expect(revisionCalls()).toBe(2));
    expect(historyCalls()).toBe(loadsBeforeInvalidation);

    revision = "revision-2";
    await panel.experimental_invalidateRpc([threadHistoryTag("thread-1")]);
    await panel.findByRole("button", { name: /subject at revision-2/ });
    expect(historyCalls()).toBe(loadsBeforeInvalidation + 1);

    await panel.experimental_invalidateRpc([threadHistoryTag("other-thread")]);
    expect(revisionCalls()).toBe(3);
    panel.lifecycle.unmount();
  });

  it("keeps the selected repository mounted through a transient discovery failure and retries", async () => {
    let discoveryCalls = 0;
    const panel = renderSlot<HistoryTabProps, typeof rpcContract>(
      historyTab(),
      { threadId: "thread-1", environment: null, params: null },
      {
        settings: {},
        experimental_rpcContract: rpcContract,
        rpc: {
          ...rpcHandlers(),
          repositories: async () => {
            discoveryCalls += 1;
            if (discoveryCalls === 2) throw new Error("temporary discovery outage");
            return {
              repositories: [{ key: "repos/api", name: "API" }],
              unavailableReason: null,
            };
          },
        },
      },
    );

    await panel.findByText("example-repo / main");
    await panel.experimental_invalidateRpc([threadHistoryTag("thread-1")]);
    await waitFor(() => expect(discoveryCalls).toBe(2));
    expect(panel.getByText("example-repo / main")).toBeTruthy();

    await panel.experimental_invalidateRpc([threadHistoryTag("thread-1")]);
    await waitFor(() => expect(discoveryCalls).toBe(3));
    expect(panel.getByText("example-repo / main")).toBeTruthy();
    panel.lifecycle.unmount();
  });

  it("rediscovers repositories when commit details report an unavailable selection", async () => {
    let discoveryCalls = 0;
    const panel = renderSlot<HistoryTabProps, typeof rpcContract>(
      historyTab(),
      { threadId: "thread-1", environment: null, params: null },
      {
        settings: {},
        experimental_rpcContract: rpcContract,
        rpc: {
          ...rpcHandlers(),
          repositories: async () => ({
            repositories: discoveryCalls++ === 0 ? [{ key: "repos/api", name: "API" }] : [],
            unavailableReason: null,
          }),
          details: async () => {
            throw new Error("GIT_HISTORY_REPOSITORY_UNAVAILABLE: selected repository disappeared");
          },
        },
      },
    );

    const commitButton = await panel.findByRole("button", { name: /render commit details/ });
    fireEvent.click(commitButton);

    await panel.findByText("No Git repositories are available in this environment.");
    expect(discoveryCalls).toBe(2);
    panel.lifecycle.unmount();
  });

  it("rediscovers repositories when an open commit patch reports an unavailable selection", async () => {
    let discoveryCalls = 0;
    const panel = renderSlot<HistoryTabProps, typeof rpcContract>(
      historyTab(),
      { threadId: "thread-1", environment: null, params: null },
      {
        settings: {},
        experimental_rpcContract: rpcContract,
        rpc: {
          ...rpcHandlers(),
          repositories: async () => ({
            repositories: discoveryCalls++ === 0 ? [{ key: "repos/api", name: "API" }] : [],
            unavailableReason: null,
          }),
          details: async () => commitDetails,
          patch: async () => {
            throw new Error("GIT_HISTORY_REPOSITORY_UNAVAILABLE: selected repository disappeared");
          },
        },
      },
    );

    const commitButton = await panel.findByRole("button", { name: /render commit details/ });
    fireEvent.click(commitButton);
    await panel.findByText("A longer explanation of the change.", { exact: false });
    fireEvent.click(panel.getByTitle("Open diff for src/example.ts"));

    await panel.findByText("No Git repositories are available in this environment.");
    expect(discoveryCalls).toBe(2);
    panel.lifecycle.unmount();
  });

  it("rediscovers repositories when an open working patch reports an unavailable selection", async () => {
    let discoveryCalls = 0;
    const panel = renderSlot<HistoryTabProps, typeof rpcContract>(
      historyTab(),
      { threadId: "thread-1", environment: null, params: null },
      {
        settings: {},
        experimental_rpcContract: rpcContract,
        rpc: {
          ...rpcHandlers(),
          repositories: async () => ({
            repositories: discoveryCalls++ === 0 ? [{ key: "repos/api", name: "API" }] : [],
            unavailableReason: null,
          }),
          history: async () => historyFor("repos/api"),
          workingPatch: async () => {
            throw new Error("GIT_HISTORY_REPOSITORY_UNAVAILABLE: selected repository disappeared");
          },
        },
      },
    );

    await panel.findByRole("button", { name: /^API history/ });
    fireEvent.click(panel.getByRole("button", { name: /Uncommitted/ }));
    fireEvent.click(panel.getByTitle("Open uncommitted diff for src/working.ts"));

    await panel.findByText("No Git repositories are available in this environment.");
    expect(discoveryCalls).toBe(2);
    panel.lifecycle.unmount();
  });
});
