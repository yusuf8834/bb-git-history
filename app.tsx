import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import {
  definePluginApp,
  experimental_Diff as Diff,
  useBbNavigate,
  useRpc,
  useSettings,
} from "@get-bb/plugin-sdk/app";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import type { rpcContract } from "./server";
import type {
  CommitDetails,
  CommitPatch,
  GitCommitSummary,
  GitFileChange,
  GitRef,
  HistoryPage,
  RepositoryDescriptor,
} from "./contracts";
import { REPOSITORY_UNAVAILABLE_ERROR_PREFIX } from "./repository-error";
import { layoutCommitGraph, type GraphRow } from "./graph";
import { Button } from "./components/ui/button";
import { Input } from "./components/ui/input";
import { Icon } from "./components/ui/icon";
import { fetchHistorySnapshot } from "./history-refresh";
import { visibleRefPillCount } from "./ref-layout";
import "./app.css";

const PAGE_SIZE = 200;
const AUTO_REFRESH_INTERVAL_MS = 15_000;
const COMMIT_ROW_HEIGHT = 31;
const DATE_HEADER_HEIGHT = 24;
const UNCOMMITTED_HEADER_HEIGHT = 28;
const UNCOMMITTED_FILE_HEIGHT = 27;
const GRAPH_WIDTH = 38;
const GRAPH_MAX_WIDTH = 86;
const GRAPH_LANE_GAP = 8;
const REPOSITORY_SEARCH_THRESHOLD = 8;
const REPOSITORY_STORAGE_PREFIX = "bb-git-history:repository:";
// Lane 0 sits exactly where the compact rail and its commit marker sit, so a
// single-lane graph is pixel-identical to the compact history.
const GRAPH_LANE_ORIGIN = GRAPH_WIDTH / 2;

function rememberedRepository(threadId: string): string | null {
  try {
    return window.localStorage.getItem(`${REPOSITORY_STORAGE_PREFIX}${threadId}`);
  } catch {
    return null;
  }
}

function rememberRepository(threadId: string, repositoryKey: string | null): void {
  try {
    const key = `${REPOSITORY_STORAGE_PREFIX}${threadId}`;
    if (repositoryKey) window.localStorage.setItem(key, repositoryKey);
    else window.localStorage.removeItem(key);
  } catch {
    // Storage can be disabled in an embedded browser; selection still works for this mount.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Git history could not be loaded.";
}

function isRepositoryUnavailableError(error: unknown): boolean {
  return error instanceof Error
    && error.message.startsWith(REPOSITORY_UNAVAILABLE_ERROR_PREFIX);
}

function exactTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "--:--";
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function exactDateTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown date";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function calendarKey(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "unknown";
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function dateGroupLabel(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "Unknown date";
  const today = new Date();
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const startDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDifference = Math.round((startToday.getTime() - startDate.getTime()) / 86_400_000);
  if (dayDifference === 0) return "Today";
  if (dayDifference === 1) return "Yesterday";

  const parts = new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("weekday")} ${part("day")} ${part("month")}`.trim();
}

type HistoryListItem =
  | {
    kind: "uncommitted-header";
    key: string;
    count: number;
  }
  | {
    kind: "uncommitted-file";
    key: string;
    file: GitFileChange;
  }
  | {
    kind: "date";
    key: string;
    label: string;
    count: number;
  }
  | {
    kind: "commit";
    key: string;
    commit: GitCommitSummary;
    commitIndex: number;
    showAuthor: boolean;
  };

function historyListItems(
  commits: GitCommitSummary[],
  uncommittedFiles: GitFileChange[],
  uncommittedExpanded: boolean,
): HistoryListItem[] {
  const groups: Array<{ key: string; label: string; commits: Array<{ commit: GitCommitSummary; index: number }> }> = [];
  for (const [index, commit] of commits.entries()) {
    const key = calendarKey(commit.authorDate);
    const current = groups.at(-1);
    if (!current || current.key !== key) {
      groups.push({
        key,
        label: dateGroupLabel(commit.authorDate),
        commits: [{ commit, index }],
      });
    } else {
      current.commits.push({ commit, index });
    }
  }

  const commitItems = groups.flatMap((group) => [
    {
      kind: "date" as const,
      key: `date-${group.key}-${group.commits[0]!.commit.hash}`,
      label: group.label,
      count: group.commits.length,
    },
    ...group.commits.map(({ commit, index }, groupIndex) => ({
      kind: "commit" as const,
      key: commit.hash,
      commit,
      commitIndex: index,
      showAuthor: groupIndex === 0 || group.commits[groupIndex - 1]?.commit.authorName !== commit.authorName,
    })),
  ]);

  if (uncommittedFiles.length === 0) return commitItems;
  const uncommittedHeader: HistoryListItem = {
    kind: "uncommitted-header",
    key: "uncommitted-header",
    count: uncommittedFiles.length,
  };
  if (!uncommittedExpanded) return [uncommittedHeader, ...commitItems];
  return [
    uncommittedHeader,
    ...uncommittedFiles.map((file) => ({
      kind: "uncommitted-file" as const,
      key: `uncommitted-${file.path}`,
      file,
    })),
    ...commitItems,
  ];
}

function subjectParts(subject: string): { prefix: string | null; text: string } {
  const match = /^([a-z][a-z0-9-]*(?:\([^)]+\))?!?:)\s*(.*)$/i.exec(subject.trim());
  if (!match) return { prefix: null, text: subject || "No commit message" };
  return { prefix: match[1] ?? null, text: match[2] || "No commit message" };
}

function refClass(ref: GitRef): string {
  if (ref.isHead) return "git-ref-head";
  switch (ref.kind) {
    case "local":
      return "git-ref-local";
    case "remote":
      return "git-ref-remote";
    case "tag":
      return "git-ref-tag";
    default:
      return "git-ref-muted";
  }
}

function refLabel(ref: GitRef): string {
  return ref.isHead ? `HEAD → ${ref.name}` : ref.name;
}

function RefPills({ refs, limit = 2 }: { refs: GitRef[]; limit?: number }) {
  const maximumVisible = Math.min(refs.length, limit);
  const [visibleCount, setVisibleCount] = useState(maximumVisible);
  const containerRef = useRef<HTMLSpanElement>(null);
  const measurementsRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measurements = measurementsRef.current;
    const parent = container?.parentElement;
    if (!container || !measurements || !parent) return;

    const update = () => {
      const styles = getComputedStyle(container);
      if (styles.display === "none") return;

      const maxWidth = styles.maxWidth.trim();
      const availableWidth = maxWidth.endsWith("%")
        ? parent.clientWidth * (Number.parseFloat(maxWidth) / 100)
        : Math.min(parent.clientWidth, Number.parseFloat(maxWidth) || parent.clientWidth);
      const counterWidths: Record<number, number> = {};

      for (const counter of Array.from(
        measurements.querySelectorAll<HTMLElement>("[data-hidden-count]"),
      )) {
        const hiddenCount = Number(counter.dataset.hiddenCount);
        counterWidths[hiddenCount] = counter.getBoundingClientRect().width;
      }

      setVisibleCount(visibleRefPillCount({
        availableWidth,
        counterWidths,
        limit,
        total: refs.length,
      }));
    };

    update();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(update);
    observer?.observe(parent);
    window.addEventListener("resize", update);

    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [limit, refs]);

  const visible = refs.slice(0, visibleCount);
  const hiddenCount = refs.length - visibleCount;
  const possibleHiddenCounts = Array.from(
    { length: maximumVisible + 1 },
    (_, visible) => refs.length - visible,
  ).filter((count) => count > 0);

  if (refs.length === 0) return null;

  return (
    <span
      className="git-refs"
      aria-label={refs.map((ref) => ref.name).join(", ")}
      ref={containerRef}
    >
      {visible.map((ref) => (
        <span className={`git-ref ${refClass(ref)}`} key={ref.fullName} title={refLabel(ref)}>
          <span className="git-ref-label">{refLabel(ref)}</span>
        </span>
      ))}
      {hiddenCount > 0 && (
        <span className="git-ref-overflow" aria-hidden="true">+{hiddenCount}</span>
      )}
      <span className="git-ref-measurements" aria-hidden="true" ref={measurementsRef}>
        {possibleHiddenCounts.map((count) => (
          <span className="git-ref-overflow" data-hidden-count={count} key={count}>
            +{count}
          </span>
        ))}
      </span>
    </span>
  );
}

function CommitSubject({ subject }: { subject: string }) {
  const { prefix, text } = subjectParts(subject);
  return (
    <span className="git-commit-subject" title={subject}>
      {prefix && <span className="git-commit-prefix">{prefix}</span>}
      {prefix && " "}
      {text}
    </span>
  );
}

function laneX(lane: number, laneGap: number, laneOffset: number): number {
  return laneOffset + lane * laneGap;
}

function GraphCell({
  row,
  width,
  laneGap,
  laneOffset,
  isHead,
}: {
  row: GraphRow;
  width: number;
  laneGap: number;
  laneOffset: number;
  isHead: boolean;
}) {
  const middle = COMMIT_ROW_HEIGHT / 2;
  const commitX = laneX(row.commitLane, laneGap, laneOffset);

  return (
    <span className="git-graph-node-cell" data-graph="true">
      <svg
        className="git-graph-cell"
        width={width}
        height={COMMIT_ROW_HEIGHT}
        viewBox={`0 0 ${width} ${COMMIT_ROW_HEIGHT}`}
        aria-hidden="true"
      >
        {row.topLanes.map((lane) => (
          <line
            key={`top-${lane}`}
            className="git-graph-lane"
            x1={laneX(lane, laneGap, laneOffset)}
            y1={0}
            x2={laneX(lane, laneGap, laneOffset)}
            y2={middle}
          />
        ))}
        {!row.startsHere && (
          <line
            className="git-graph-lane"
            x1={commitX}
            y1={0}
            x2={commitX}
            y2={middle}
          />
        )}
        {row.bottomLanes.map((lane) => (
          <line
            key={`bottom-${lane}`}
            className="git-graph-lane"
            x1={laneX(lane, laneGap, laneOffset)}
            y1={middle}
            x2={laneX(lane, laneGap, laneOffset)}
            y2={COMMIT_ROW_HEIGHT}
          />
        ))}
        {row.edges.map((edge, index) => {
          const fromX = laneX(edge.fromLane, laneGap, laneOffset);
          const toX = laneX(edge.toLane, laneGap, laneOffset);
          if (edge.kind === "straight") {
            return (
              <line
                key={`edge-${index}`}
                className="git-graph-lane"
                x1={fromX}
                y1={middle}
                x2={toX}
                y2={COMMIT_ROW_HEIGHT}
              />
            );
          }
          return (
            <path
              key={`edge-${index}`}
              className="git-graph-lane"
              d={`M ${fromX} ${middle} C ${fromX} ${middle + 8}, ${toX} ${middle + 7}, ${toX} ${COMMIT_ROW_HEIGHT}`}
            />
          );
        })}
      </svg>
      <span
        className="git-graph-node"
        data-head={isHead || undefined}
        style={{ left: `${commitX}px` }}
      />
    </span>
  );
}

function commitMatches(commit: GitCommitSummary, rawQuery: string): boolean {
  const query = rawQuery.trim().toLocaleLowerCase();
  if (!query) return false;
  return [
    commit.subject,
    commit.hash,
    commit.authorName,
    commit.authorEmail,
    ...commit.refs.map((ref) => ref.name),
  ].some((value) => value.toLocaleLowerCase().includes(query));
}

function CommitList({
  threadId,
  repositoryKey,
  commits,
  uncommittedFiles,
  uncommittedExpanded,
  hasMore,
  loadingMore,
  query,
  expandedHash,
  experimentalGraph,
  scrollRef,
  onLoadMore,
  onToggleCommit,
  onOpenDiff,
  onOpenWorkingDiff,
  onToggleUncommitted,
  onRepositoryUnavailable,
}: {
  threadId: string;
  repositoryKey: string;
  commits: GitCommitSummary[];
  uncommittedFiles: GitFileChange[];
  uncommittedExpanded: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  query: string;
  expandedHash: string | null;
  experimentalGraph: boolean;
  scrollRef: RefObject<HTMLDivElement | null>;
  onLoadMore: () => void;
  onToggleCommit: (hash: string) => void;
  onOpenDiff: (commit: GitCommitSummary, details: CommitDetails, path: string) => void;
  onOpenWorkingDiff: (path: string) => void;
  onToggleUncommitted: () => void;
  onRepositoryUnavailable: () => void;
}) {
  const listItems = useMemo(
    () => historyListItems(commits, uncommittedFiles, uncommittedExpanded),
    [commits, uncommittedExpanded, uncommittedFiles],
  );
  const matches = useMemo(
    () => commits.map((commit) => commitMatches(commit, query)),
    [commits, query],
  );
  const graphRows = useMemo(
    () => experimentalGraph ? layoutCommitGraph(commits) : [],
    [commits, experimentalGraph],
  );
  const maxLaneCount = graphRows.reduce(
    (maximum, row) => Math.max(maximum, row.laneCount),
    1,
  );
  const graphWidth = experimentalGraph
    ? Math.min(GRAPH_MAX_WIDTH, GRAPH_WIDTH + (maxLaneCount - 1) * GRAPH_LANE_GAP)
    : GRAPH_WIDTH;
  const laneGap = maxLaneCount <= 1
    ? 0
    : Math.min(GRAPH_LANE_GAP, (graphWidth - GRAPH_WIDTH) / (maxLaneCount - 1));
  const laneOffset = GRAPH_LANE_ORIGIN;
  const virtualizer = useVirtualizer({
    count: listItems.length,
    getScrollElement: () => scrollRef.current,
    getItemKey: (index) => listItems[index]?.key ?? index,
    estimateSize: (index) => {
      switch (listItems[index]?.kind) {
        case "date":
          return DATE_HEADER_HEIGHT;
        case "uncommitted-header":
          return UNCOMMITTED_HEADER_HEIGHT;
        case "uncommitted-file":
          return UNCOMMITTED_FILE_HEIGHT;
        default:
          return COMMIT_ROW_HEIGHT;
      }
    },
    overscan: 12,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const lastVisibleIndex = virtualItems.at(-1)?.index ?? 0;
  const scrollOffset = virtualizer.scrollOffset ?? 0;
  const firstVisibleIndex = virtualItems.find((item) => item.end > scrollOffset)?.index ?? 0;
  let activeDate: Extract<HistoryListItem, { kind: "date" }> | null = null;
  for (let index = firstVisibleIndex; index >= 0; index -= 1) {
    const item = listItems[index];
    if (item?.kind === "date") {
      activeDate = item;
      break;
    }
  }

  useEffect(() => {
    if (hasMore && !loadingMore && lastVisibleIndex >= listItems.length - 30) {
      onLoadMore();
    }
  }, [hasMore, lastVisibleIndex, listItems.length, loadingMore, onLoadMore]);

  useEffect(() => {
    virtualizer.measure();
  }, [expandedHash, uncommittedExpanded, virtualizer]);

  return (
    <div className="git-history-scroll" ref={scrollRef} role="list">
      <div
        className="git-history-virtual"
        data-graph={experimentalGraph || undefined}
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        {activeDate && (
          <div
            className="git-date-header git-date-header-sticky"
            aria-hidden="true"
            style={{ transform: `translateY(${scrollOffset}px)` }}
          >
            <span>{activeDate.label}</span>
            <span className="git-date-rule" />
            <span>{activeDate.count}</span>
          </div>
        )}
        {virtualItems.map((virtualRow) => {
          const item = listItems[virtualRow.index];
          if (!item) return null;
          if (item.kind === "uncommitted-header") {
            return (
              <div
                className="git-uncommitted-header-listitem"
                data-index={virtualRow.index}
                key={item.key}
                ref={virtualizer.measureElement}
                role="listitem"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <button
                  className="git-uncommitted-header"
                  aria-expanded={uncommittedExpanded}
                  onClick={onToggleUncommitted}
                  title={uncommittedExpanded
                    ? "Collapse uncommitted files"
                    : "Expand uncommitted files"}
                >
                  <Icon
                    name="ChevronRight"
                    className="git-uncommitted-toggle-icon"
                    aria-hidden="true"
                  />
                  <span>Uncommitted</span>
                  <span className="git-date-rule" />
                  <span>{item.count}</span>
                </button>
              </div>
            );
          }
          if (item.kind === "uncommitted-file") {
            const parts = pathParts(item.file.path);
            return (
              <div
                className="git-uncommitted-file-listitem"
                data-index={virtualRow.index}
                key={item.key}
                ref={virtualizer.measureElement}
                role="listitem"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <button
                  className="git-uncommitted-file-row"
                  onClick={() => onOpenWorkingDiff(item.file.path)}
                  title={`Open uncommitted diff for ${item.file.path}`}
                >
                  <span className={`git-file-status git-file-status-${item.file.status}`}>
                    <span className="sr-only">{item.file.status}</span>
                    {statusLetter(item.file.status)}
                  </span>
                  <span className="git-file-path">
                    {parts.directory && <span>{parts.directory}</span>}
                    <strong>{parts.filename}</strong>
                  </span>
                  <span className="git-file-stats">
                    {item.file.additions !== null && <span>+{item.file.additions}</span>}
                    {item.file.deletions !== null && <span>−{item.file.deletions}</span>}
                  </span>
                </button>
              </div>
            );
          }
          if (item.kind === "date") {
            return (
              <div
                className="git-date-listitem"
                data-index={virtualRow.index}
                key={item.key}
                ref={virtualizer.measureElement}
                role="presentation"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
              >
                <div className="git-date-header">
                  <span>{item.label}</span>
                  <span className="git-date-rule" />
                  <span>{item.count}</span>
                </div>
              </div>
            );
          }

          const { commit, commitIndex, showAuthor } = item;
          const isMerge = commit.parents.length > 1;
          const isHead = commit.refs.some((ref) => ref.isHead);
          const graphRow = graphRows[commitIndex];
          const isExpanded = expandedHash === commit.hash;
          const expansionId = `git-commit-files-${commit.hash}`;
          return (
            <div
              className="git-commit-listitem"
              data-index={virtualRow.index}
              key={commit.hash}
              ref={virtualizer.measureElement}
              role="listitem"
              style={{
                transform: `translateY(${virtualRow.start}px)`,
              }}
            >
              <button
                className={`git-commit-row ${matches[commitIndex] ? "git-commit-match" : ""}`}
                aria-controls={expansionId}
                aria-expanded={isExpanded}
                data-head={isHead || undefined}
                data-merge={isMerge || undefined}
                data-expanded={isExpanded || undefined}
                data-graph={experimentalGraph || undefined}
                style={{ "--git-graph-width": `${graphWidth}px` } as CSSProperties}
                onClick={() => onToggleCommit(commit.hash)}
                title={isExpanded ? "Collapse changed files" : "Show changed files"}
              >
                {experimentalGraph && graphRow
                  ? (
                    <GraphCell
                      row={graphRow}
                      width={graphWidth}
                      laneGap={laneGap}
                      laneOffset={laneOffset}
                      isHead={isHead}
                    />
                  )
                  : (
                    <span className="git-graph-node-cell">
                      <span className="git-graph-node" data-head={isHead || undefined} />
                    </span>
                  )}
                <Icon name="ChevronRight" className="git-commit-expand-icon" aria-hidden="true" />
                <span className="git-commit-copy">
                  <CommitSubject subject={commit.subject} />
                  <RefPills refs={commit.refs} />
                </span>
                <span className="git-commit-inline-meta">
                  {isExpanded && <code>{commit.hash.slice(0, 7)}</code>}
                  {showAuthor && <span className="git-commit-author">{commit.authorName}</span>}
                  <time dateTime={commit.authorDate}>{exactTime(commit.authorDate)}</time>
                </span>
              </button>
              {isExpanded && (
                <InlineCommitFiles
                  id={expansionId}
                  threadId={threadId}
                  repositoryKey={repositoryKey}
                  commit={commit}
                  experimentalGraph={experimentalGraph}
                  graphWidth={graphWidth}
                  graphRow={graphRow}
                  laneGap={laneGap}
                  laneOffset={laneOffset}
                  onOpenDiff={onOpenDiff}
                  onRepositoryUnavailable={onRepositoryUnavailable}
                />
              )}
            </div>
          );
        })}
      </div>
      {loadingMore && (
        <div className="git-loading-more" role="status">
          <Icon name="Loading" className="animate-spin" />
          Loading older commits
        </div>
      )}
    </div>
  );
}

function statusLetter(status: GitFileChange["status"]): string {
  switch (status) {
    case "added":
      return "A";
    case "conflicted":
      return "U";
    case "copied":
      return "C";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    case "type-changed":
      return "T";
    case "modified":
      return "M";
    case "unknown":
      return "?";
  }
}

function pathParts(path: string): { directory: string; filename: string } {
  const separator = path.lastIndexOf("/");
  if (separator < 0) return { directory: "", filename: path };
  return {
    directory: path.slice(0, separator + 1),
    filename: path.slice(separator + 1),
  };
}

function changeTotals(files: GitFileChange[]): { additions: number; deletions: number } {
  return files.reduce(
    (totals, file) => ({
      additions: totals.additions + (file.additions ?? 0),
      deletions: totals.deletions + (file.deletions ?? 0),
    }),
    { additions: 0, deletions: 0 },
  );
}

function InlineCommitFiles({
  id,
  threadId,
  repositoryKey,
  commit,
  experimentalGraph,
  graphWidth,
  graphRow,
  laneGap,
  laneOffset,
  onOpenDiff,
  onRepositoryUnavailable,
}: {
  id: string;
  threadId: string;
  repositoryKey: string;
  commit: GitCommitSummary;
  experimentalGraph: boolean;
  graphWidth: number;
  graphRow: GraphRow | undefined;
  laneGap: number;
  laneOffset: number;
  onOpenDiff: (commit: GitCommitSummary, details: CommitDetails, path: string) => void;
  onRepositoryUnavailable: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [details, setDetails] = useState<CommitDetails | null>(null);
  const [detailsError, setDetailsError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setDetails(null);
    setDetailsError(null);
    void rpc
      .call("details", { threadId, repositoryKey, hash: commit.hash })
      .then((result) => {
        if (active) setDetails(result);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (isRepositoryUnavailableError(error)) {
          setDetailsError("This repository is no longer available.");
          onRepositoryUnavailable();
          return;
        }
        setDetailsError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [commit.hash, onRepositoryUnavailable, repositoryKey, rpc, threadId]);

  const totals = details ? changeTotals(details.files) : null;
  const continuationLanes = graphRow
    ? Array.from(new Set([
      ...graphRow.bottomLanes,
      ...graphRow.edges.map((edge) => edge.toLane),
    ]))
    : [];

  return (
    <div
      className="git-commit-expansion"
      id={id}
      role="region"
      aria-label={`Details for ${commit.subject || commit.hash.slice(0, 8)}`}
      style={{ marginLeft: `${graphWidth}px` }}
    >
      {experimentalGraph && continuationLanes.length > 0 && (
        <svg
          className="git-expansion-graph"
          width={graphWidth}
          height="100%"
          viewBox={`0 0 ${graphWidth} 100`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {continuationLanes.map((lane) => (
            <line
              key={lane}
              className="git-graph-lane"
              x1={laneX(lane, laneGap, laneOffset)}
              y1={0}
              x2={laneX(lane, laneGap, laneOffset)}
              y2={100}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      )}
      {detailsError && <div className="git-inline-error" role="alert">{detailsError}</div>}
      {!details && !detailsError && (
        <div className="git-detail-loading" role="status">
          <Icon name="Loading" className="animate-spin" />
          Loading changed files
        </div>
      )}

      {details && (
        <section className="git-files">
          <div className="git-commit-details">
            <div className="git-commit-details-meta">
              <code title={details.hash}>{details.hash}</code>
              <span title={details.authorEmail}>
                {details.authorName} &lt;{details.authorEmail}&gt;
              </span>
              <time dateTime={details.authorDate}>{exactDateTime(details.authorDate)}</time>
            </div>
            {details.body.trim() && (
              <pre className="git-commit-body">{details.body.trimEnd()}</pre>
            )}
          </div>
          <div className="git-files-summary">
            <span>{details.files.length} {details.files.length === 1 ? "file" : "files"}</span>
            <span className="git-stat-added">+{totals?.additions ?? 0}</span>
            <span className="git-stat-removed">−{totals?.deletions ?? 0}</span>
          </div>
          {details.files.length === 0 && (
            <div className="git-empty-files">No file changes to show.</div>
          )}
          {details.files.map((file) => {
            const parts = pathParts(file.path);
            return (
              <div className="git-inline-file" key={file.path}>
                <button
                  className="git-file-row"
                  onClick={() => onOpenDiff(commit, details, file.path)}
                  title={`Open diff for ${file.path}`}
                >
                  <span className={`git-file-status git-file-status-${file.status}`}>
                    <span className="sr-only">{file.status}</span>
                    {statusLetter(file.status)}
                  </span>
                  <span className="git-file-path">
                    {parts.directory && <span>{parts.directory}</span>}
                    <strong>{parts.filename}</strong>
                  </span>
                  <span className="git-file-stats">
                    {file.additions !== null && (
                      <span data-zero={file.additions === 0 || undefined}>+{file.additions}</span>
                    )}
                    {file.deletions !== null && (
                      <span data-zero={file.deletions === 0 || undefined}>−{file.deletions}</span>
                    )}
                  </span>
                </button>
              </div>
            );
          })}
        </section>
      )}
    </div>
  );
}

function FileDiffPanel({
  threadId,
  repositoryKey,
  source,
  files,
  initialPath,
  onBack,
  onRepositoryUnavailable,
}: {
  threadId: string;
  repositoryKey: string;
  source:
    | { kind: "commit"; hash: string; label: string }
    | { kind: "working-tree"; label: string };
  files: GitFileChange[];
  initialPath: string;
  onBack: () => void;
  onRepositoryUnavailable: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [path, setPath] = useState(initialPath);
  const [patch, setPatch] = useState<CommitPatch | null>(null);
  const [patchError, setPatchError] = useState<string | null>(null);
  const [wrapLines, setWrapLines] = useState(false);
  const fileIndex = Math.max(0, files.findIndex((file) => file.path === path));
  const file = files[fileIndex] ?? null;
  const filename = pathParts(path).filename || path;

  useEffect(() => {
    let active = true;
    setPatch(null);
    setPatchError(null);
    const request = source.kind === "commit"
      ? rpc.call("patch", { threadId, repositoryKey, hash: source.hash, path })
      : rpc.call("workingPatch", { threadId, repositoryKey, path });
    void request
      .then((result) => {
        if (active) setPatch(result);
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (isRepositoryUnavailableError(error)) {
          setPatchError("This repository is no longer available.");
          onRepositoryUnavailable();
          return;
        }
        setPatchError(errorMessage(error));
      });
    return () => {
      active = false;
    };
  }, [onRepositoryUnavailable, path, repositoryKey, rpc, source, threadId]);

  return (
    <div className="git-history-panel git-diff-panel">
      <div className="git-diff-header">
        <Button
          variant="ghost"
          size="icon"
          className="git-icon-button"
          aria-label="Back to Git history"
          title="Back to Git history"
          onClick={onBack}
        >
          <Icon name="ChevronLeft" aria-hidden="true" />
        </Button>
        <div className="git-diff-title">
          <strong title={path}>{filename}</strong>
          <span title={source.label}>{source.label}</span>
        </div>
        {file && (
          <div className="git-diff-stats">
            {file.additions !== null && <span>+{file.additions}</span>}
            {file.deletions !== null && <span>−{file.deletions}</span>}
          </div>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="git-icon-button"
          aria-label="Wrap long lines"
          aria-pressed={wrapLines}
          title="Wrap long lines"
          onClick={() => setWrapLines((current) => !current)}
        >
          <Icon name="TextWrap" aria-hidden="true" />
        </Button>
      </div>

      <div className="git-file-strip" aria-label="Changed files">
        <span>{fileIndex + 1} / {files.length}</span>
        <div>
          {files.map((candidate) => {
            const candidateName = pathParts(candidate.path).filename || candidate.path;
            return (
              <button
                key={candidate.path}
                data-active={candidate.path === path || undefined}
                onClick={() => setPath(candidate.path)}
                title={candidate.path}
              >
                {candidateName}
              </button>
            );
          })}
        </div>
      </div>

      <div className="git-diff-body">
        {!patch && !patchError && (
          <div className="git-detail-loading" role="status">
            <Icon name="Loading" className="animate-spin" aria-hidden="true" />
            Loading diff
          </div>
        )}
        {patchError && <div className="git-inline-error" role="alert">{patchError}</div>}
        {patch?.patch && (
          <Diff
            patch={patch.patch}
            path={patch.path}
            overflow={wrapLines ? "wrap" : "scroll"}
          />
        )}
        {patch && !patch.patch && (
          <div className="git-empty-files">No textual diff for this file.</div>
        )}
        {patch?.truncated && (
          <div className="git-patch-note">Diff truncated at 1.5 MB.</div>
        )}
      </div>

      <div className="git-footer">
        <span>
          {((file?.additions ?? 0) + (file?.deletions ?? 0)).toLocaleString()} changed lines
        </span>
      </div>
    </div>
  );
}

function RepositoryNavigator({
  repositories,
  selectedKey,
  onSelect,
}: {
  repositories: RepositoryDescriptor[];
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [query, setQuery] = useState("");
  const selectedRepository = repositories.find((repository) => repository.key === selectedKey);
  const filteredRepositories = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    if (!normalizedQuery) return repositories;
    return repositories.filter((repository) =>
      repository.name.toLocaleLowerCase().includes(normalizedQuery)
      || repository.currentBranch?.toLocaleLowerCase().includes(normalizedQuery));
  }, [query, repositories]);

  return (
    <nav className="git-repository-navigator" aria-label="Repositories">
      <button
        type="button"
        className="git-repository-navigator-header"
        aria-expanded={expanded}
        aria-label={expanded ? "Collapse repositories" : "Expand repositories"}
        onClick={() => setExpanded((current) => !current)}
      >
        <Icon name={expanded ? "ChevronDown" : "ChevronRight"} aria-hidden="true" />
        <strong>Repositories</strong>
        <span className="git-repository-count">{repositories.length.toLocaleString()}</span>
        {!expanded && selectedRepository && (
          <span className="git-repository-collapsed-selection">{selectedRepository.name}</span>
        )}
      </button>
      {expanded && (
        <>
          {(repositories.length > REPOSITORY_SEARCH_THRESHOLD || query.length > 0) && (
            <div className="git-repository-search">
              <Icon name="Search" aria-hidden="true" />
              <Input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search repositories"
                aria-label="Search repositories"
              />
            </div>
          )}
          <div className="git-repository-list" role="list">
            {filteredRepositories.map((repository) => {
              const selected = repository.key === selectedKey;
              const dirtyCount = repository.dirtyCount;
              const branch = repository.currentBranch ?? "Detached HEAD";
              return (
                <div key={repository.key} role="listitem">
                  <button
                    type="button"
                    className="git-repository-row"
                    data-selected={selected || undefined}
                    aria-pressed={selected}
                    aria-label={`Show ${repository.name} history`}
                    onClick={() => onSelect(repository.key)}
                  >
                    <Icon name="FolderGit" className="git-repository-row-icon" aria-hidden="true" />
                    <span className="git-repository-row-copy">
                      <strong title={repository.name}>{repository.name}</strong>
                      <span title={branch}>
                        <Icon name="GitBranch" aria-hidden="true" />
                        {branch}
                      </span>
                    </span>
                    <span
                      className="git-repository-status"
                      data-dirty={(typeof dirtyCount === "number" && dirtyCount > 0) || undefined}
                    >
                      {dirtyCount === null || dirtyCount === undefined
                        ? "Status unavailable"
                        : dirtyCount === 0
                          ? "Clean"
                          : `${dirtyCount.toLocaleString()} ${dirtyCount === 1 ? "change" : "changes"}`}
                    </span>
                  </button>
                </div>
              );
            })}
            {filteredRepositories.length === 0 && (
              <div className="git-repository-empty">No matching repositories.</div>
            )}
          </div>
        </>
      )}
    </nav>
  );
}

function GitHistoryPanel({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [repositories, setRepositories] = useState<RepositoryDescriptor[]>([]);
  const [repositoryKey, setRepositoryKey] = useState<string | null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(true);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const discoverySequence = useRef(0);
  const discoveryRequest = useRef<{
    threadId: string;
    promise: Promise<RepositoryDescriptor[]>;
  } | null>(null);
  const hasDiscoveredRepositories = useRef(false);

  const refreshRepositories = useCallback((): Promise<RepositoryDescriptor[]> => {
    if (discoveryRequest.current?.threadId === threadId) {
      return discoveryRequest.current.promise;
    }

    const sequence = ++discoverySequence.current;
    const request = (async (): Promise<RepositoryDescriptor[]> => {
      setDiscoveryLoading(true);
      try {
        const result = await rpc.call("repositories", { threadId });
        if (sequence !== discoverySequence.current) return [];
        const isInitialDiscovery = !hasDiscoveredRepositories.current;
        hasDiscoveredRepositories.current = true;
        setRepositories(result.repositories);
        setDiscoveryError(result.unavailableReason);
        setRepositoryKey((current) => {
          if (isInitialDiscovery) {
            const remembered = rememberedRepository(threadId);
            return result.repositories.find((repository) => repository.key === remembered)?.key
              ?? result.repositories[0]?.key
              ?? null;
          }
          if (current && result.repositories.some((repository) => repository.key === current)) {
            return current;
          }
          rememberRepository(threadId, null);
          return null;
        });
        return result.repositories;
      } catch (error) {
        if (sequence === discoverySequence.current) {
          if (!hasDiscoveredRepositories.current) {
            setDiscoveryError(errorMessage(error));
          }
        }
        return [];
      } finally {
        if (sequence === discoverySequence.current) setDiscoveryLoading(false);
      }
    })();
    discoveryRequest.current = { threadId, promise: request };
    void request.finally(() => {
      if (discoveryRequest.current?.promise === request) {
        discoveryRequest.current = null;
      }
    });
    return request;
  }, [rpc, threadId]);

  useEffect(() => {
    hasDiscoveredRepositories.current = false;
    setRepositoryKey(null);
    void refreshRepositories();
  }, [refreshRepositories]);

  const recoverRepository = useCallback(() => {
    void refreshRepositories();
  }, [refreshRepositories]);

  const selectRepository = useCallback((key: string) => {
    rememberRepository(threadId, key);
    setRepositoryKey(key);
  }, [threadId]);

  const repositoryNavigator = (
    repositories.length > 1
    || (repositories.length > 0 && repositoryKey === null)
  ) ? (
    <RepositoryNavigator
      repositories={repositories}
      selectedKey={repositoryKey}
      onSelect={selectRepository}
    />
  ) : null;

  if (repositoryKey) {
    return (
      <div className="git-history-workspace">
        {repositoryNavigator}
        <RepositoryHistoryPanel
          key={`${threadId}:${repositoryKey}`}
          threadId={threadId}
          repositoryKey={repositoryKey}
          onRefreshRepositories={refreshRepositories}
          onRepositoryUnavailable={recoverRepository}
        />
      </div>
    );
  }

  return (
    <div className="git-history-workspace">
      {repositoryNavigator}
      <div className="git-history-panel">
        {discoveryLoading ? (
          <div className="git-state" role="status">
            <Icon name="Loading" className="animate-spin" />
            <span>Finding Git repositories</span>
          </div>
        ) : (
          <div className="git-state git-state-error" role="alert">
            <Icon name="AlertCircle" />
            <strong>Git history unavailable</strong>
            <span>{discoveryError
              ?? (repositories.length > 0
                ? "The selected repository is no longer available."
                : "No Git repositories are available in this environment.")}
            </span>
            <Button variant="outline" size="sm" onClick={() => void refreshRepositories()}>
              Try again
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function RepositoryHistoryPanel({
  threadId,
  repositoryKey,
  onRefreshRepositories,
  onRepositoryUnavailable,
}: {
  threadId: string;
  repositoryKey: string;
  onRefreshRepositories: () => Promise<RepositoryDescriptor[]>;
  onRepositoryUnavailable: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const { values: settings } = useSettings();
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [commits, setCommits] = useState<GitCommitSummary[]>([]);
  const [query, setQuery] = useState("");
  const [uncommittedExpanded, setUncommittedExpanded] = useState(false);
  const [expandedHash, setExpandedHash] = useState<string | null>(null);
  const [diffView, setDiffView] = useState<{
    kind: "commit";
    commit: GitCommitSummary;
    details: CommitDetails;
    path: string;
  } | {
    kind: "working-tree";
    files: GitFileChange[];
    path: string;
  } | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);
  const historyRevisionRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pendingScrollRestore = useRef<number | null>(null);

  const loadHistory = useCallback(
    async (reset: boolean, options?: { silent?: boolean }) => {
      const sequence = ++requestSequence.current;
      const offset = reset ? 0 : commits.length;
      if (reset) {
        if (options?.silent && scrollRef.current) {
          pendingScrollRestore.current = scrollRef.current.scrollTop;
        }
        if (!options?.silent) {
          setInitialLoading(true);
        }
        setError(null);
      } else {
        setLoadingMore(true);
      }

      try {
        const fetchPage = (pageOffset: number, limit: number) =>
          rpc.call("history", {
            threadId,
            repositoryKey,
            offset: pageOffset,
            limit,
          });
        let replaceCommits = reset;
        let result = reset
          ? await fetchHistorySnapshot(
            fetchPage,
            options?.silent ? Math.max(commits.length, PAGE_SIZE) : PAGE_SIZE,
            PAGE_SIZE,
          )
          : await fetchPage(offset, PAGE_SIZE);
        if (
          !reset
          && historyRevisionRef.current !== null
          && result.revision !== historyRevisionRef.current
        ) {
          if (scrollRef.current) {
            pendingScrollRestore.current = scrollRef.current.scrollTop;
          }
          result = await fetchHistorySnapshot(
            fetchPage,
            Math.max(commits.length, PAGE_SIZE),
            PAGE_SIZE,
          );
          replaceCommits = true;
        }
        if (sequence !== requestSequence.current) return;
        setPage(result);
        historyRevisionRef.current = result.revision;
        setError(result.unavailableReason);
        setCommits((current) => {
          if (replaceCommits) return result.commits;
          const known = new Set(current.map((commit) => commit.hash));
          return [
            ...current,
            ...result.commits.filter((commit) => !known.has(commit.hash)),
          ];
        });
      } catch (loadError) {
        if (sequence === requestSequence.current) setError(errorMessage(loadError));
      } finally {
        if (sequence === requestSequence.current) {
          setInitialLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [commits.length, repositoryKey, rpc, threadId],
  );

  const refreshHistory = useCallback(async () => {
    const discoveredRepositories = await onRefreshRepositories();
    if (discoveredRepositories.some((repository) => repository.key === repositoryKey)) {
      await loadHistory(true);
    }
  }, [loadHistory, onRefreshRepositories, repositoryKey]);

  useLayoutEffect(() => {
    if (pendingScrollRestore.current === null || !scrollRef.current) return;
    scrollRef.current.scrollTop = pendingScrollRestore.current;
    pendingScrollRestore.current = null;
  }, [commits, page?.revision]);

  useEffect(() => {
    setCommits([]);
    setPage(null);
    setUncommittedExpanded(false);
    setExpandedHash(null);
    setDiffView(null);
    historyRevisionRef.current = null;
    void loadHistory(true);
  }, [repositoryKey, threadId]);

  useEffect(() => {
    if (initialLoading) return;

    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const schedule = (delay = AUTO_REFRESH_INTERVAL_MS) => {
      timeoutId = setTimeout(() => {
        void tick();
      }, delay);
    };

    const tick = async () => {
      if (cancelled) return;
      if (document.hidden || diffView !== null) {
        schedule();
        return;
      }

      try {
        const discoveredRepositories = await onRefreshRepositories();
        if (!discoveredRepositories.some((repository) => repository.key === repositoryKey)) {
          schedule();
          return;
        }
        const result = await rpc.call("historyRevision", { threadId, repositoryKey });
        if (cancelled) return;
        if (result.unavailableReason) {
          schedule();
          return;
        }

        const previousRevision = historyRevisionRef.current;
        if (previousRevision !== null && result.revision !== previousRevision) {
          await loadHistory(true, { silent: true });
        } else if (previousRevision === null) {
          historyRevisionRef.current = result.revision;
        }
      } catch {
        // Ignore transient poll failures.
      }

      schedule();
    };

    const onVisibilityChange = () => {
      if (!document.hidden && diffView === null) {
        clearTimeout(timeoutId);
        void tick();
      }
    };

    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      clearTimeout(timeoutId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [diffView, initialLoading, loadHistory, onRefreshRepositories, repositoryKey, rpc, threadId]);

  useEffect(() => {
    if (expandedHash && !commits.some((commit) => commit.hash === expandedHash)) {
      setExpandedHash(null);
    }
  }, [commits, expandedHash]);

  const matchingCount = useMemo(
    () => commits.filter((commit) => commitMatches(commit, query)).length,
    [commits, query],
  );
  const uncommittedFiles = page?.uncommittedFiles ?? [];
  const hasHistoryItems = commits.length > 0 || uncommittedFiles.length > 0;

  return (
    <div className="git-history-view-stack">
      <div
        className="git-history-panel"
        aria-hidden={diffView !== null}
        data-inactive={diffView !== null || undefined}
      >
      <div className="git-toolbar">
        <div className="git-repository">
          <strong>History</strong>
          <span title={`${page?.repoName ?? "Repository"} / ${page?.currentBranch ?? "Detached HEAD"}`}>
            {page?.repoName ?? "Repository"} / {page?.currentBranch ?? "Detached HEAD"}
          </span>
        </div>
        <div className="git-toolbar-actions">
          <Button
            variant="ghost"
            size="icon"
            className="git-icon-button"
            aria-label="Refresh Git history"
            title="Refresh Git history"
            disabled={initialLoading}
            onClick={() => void refreshHistory()}
          >
            <Icon
              name={initialLoading ? "Loading" : "ArrowReloadHorizontal"}
              className={initialLoading ? "animate-spin" : ""}
              aria-hidden="true"
            />
          </Button>
        </div>
      </div>

      <div className="git-search-wrap">
        <Icon name="Search" />
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Find in loaded commits"
          aria-label="Find in loaded commits"
        />
        {query && (
          <span className="git-search-count" role="status">
            {matchingCount.toLocaleString()} {matchingCount === 1 ? "match" : "matches"}
          </span>
        )}
      </div>

      {initialLoading && commits.length === 0 && (
        <div className="git-state" role="status">
          <Icon name="Loading" className="animate-spin" />
          <span>Reading all refs</span>
        </div>
      )}

      {error && commits.length === 0 && (
        <div className="git-state git-state-error" role="alert">
          <Icon name="AlertCircle" />
          <strong>Git history unavailable</strong>
          <span>{error}</span>
          <Button variant="outline" size="sm" onClick={() => void loadHistory(true)}>
            Try again
          </Button>
        </div>
      )}

      {!initialLoading && !error && !hasHistoryItems && (
        <div className="git-state" role="status">
          <Icon name="FolderGit" />
          <span>This repository has no reachable commits.</span>
        </div>
      )}

      {hasHistoryItems && (
          <CommitList
          threadId={threadId}
          repositoryKey={repositoryKey}
          commits={commits}
          uncommittedFiles={uncommittedFiles}
          uncommittedExpanded={uncommittedExpanded}
          hasMore={page?.hasMore ?? false}
          loadingMore={loadingMore}
          query={query}
          expandedHash={expandedHash}
          experimentalGraph={settings?.experimentalCommitGraph !== false}
          scrollRef={scrollRef}
          onLoadMore={() => void loadHistory(false)}
          onToggleCommit={(hash) => {
            setExpandedHash((current) => current === hash ? null : hash);
          }}
          onOpenDiff={(commit, details, path) => {
            setDiffView({ kind: "commit", commit, details, path });
          }}
          onOpenWorkingDiff={(path) => {
            setDiffView({ kind: "working-tree", files: uncommittedFiles, path });
          }}
          onToggleUncommitted={() => {
            setUncommittedExpanded((current) => !current);
          }}
          onRepositoryUnavailable={onRepositoryUnavailable}
        />
      )}

      {hasHistoryItems && (
        <div className="git-footer">
          <span>{commits.length.toLocaleString()} commits</span>
          <span aria-hidden="true">·</span>
          <span>{page?.hasMore ? `${(page.total - commits.length).toLocaleString()} more` : "all loaded"}</span>
        </div>
      )}
      </div>
      {diffView && (
        <FileDiffPanel
          key={diffView.kind === "commit" ? diffView.commit.hash : "working-tree"}
          threadId={threadId}
          repositoryKey={repositoryKey}
          source={diffView.kind === "commit"
            ? {
              kind: "commit",
              hash: diffView.commit.hash,
              label: `${diffView.commit.subject} · ${diffView.commit.hash.slice(0, 7)}`,
            }
            : { kind: "working-tree", label: "Uncommitted changes" }}
          files={diffView.kind === "commit" ? diffView.details.files : diffView.files}
          initialPath={diffView.path}
          onBack={() => setDiffView(null)}
          onRepositoryUnavailable={onRepositoryUnavailable}
        />
      )}
    </div>
  );
}

function GitHistoryHeaderAction({ threadId }: { threadId: string }) {
  const navigate = useBbNavigate();
  const { values } = useSettings();
  if (values?.showHeaderShortcut !== true) return null;

  return (
    <button
      className="git-header-action"
      aria-label="Open Git history"
      title="Open Git history"
      onClick={() => {
        const opened = navigate.openThreadPanel({
          actionId: "history",
          title: "Git History",
        });
        if (!opened) toast.error("Git History could not open on this panel.");
      }}
      data-thread-id={threadId}
    >
      <Icon name="FolderGit" aria-hidden="true" />
    </button>
  );
}

export default definePluginApp((app) => {
  app.slots.threadPanelAction({
    id: "history",
    title: "Git History",
    icon: "FolderGit",
    component: GitHistoryPanel,
    layout: "flush",
  });

  app.slots.experimental_threadHeaderAction({
    id: "git-history",
    title: "Git History",
    component: GitHistoryHeaderAction,
  });
});
