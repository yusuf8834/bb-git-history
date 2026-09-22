import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { experimental_defineHostEntry } from "@get-bb/plugin-sdk/host";
import type {
  CommitDetails,
  GitCommitSummary,
  GitFileChange,
  GitRef,
} from "./contracts";
import { hostContract } from "./contracts";
import { REPOSITORY_UNAVAILABLE_ERROR_PREFIX } from "./repository-error";
import {
  discoverRepositories,
  resolveRepositorySelection,
  runGit,
} from "./repository-discovery";

const SUMMARY_FIELD_COUNT = 7;
const DETAIL_FIELD_COUNT = 8;
const MAX_PATCH_CHARS = 1_500_000;
const HIDDEN_REF_NAMESPACES = ["refs/t3/checkpoints"] as const;
const VISIBLE_HISTORY_REVISIONS = [
  "--exclude=refs/t3/checkpoints",
  "--exclude=refs/t3/checkpoints/*",
  "--all",
] as const;

function isHiddenRef(fullName: string): boolean {
  return HIDDEN_REF_NAMESPACES.some(
    (namespace) => fullName === namespace || fullName.startsWith(`${namespace}/`),
  );
}

async function runGitOptional(
  cwd: string,
  args: string[],
  signal: AbortSignal,
): Promise<string | null> {
  try {
    return await runGit(cwd, args, signal);
  } catch {
    return null;
  }
}

async function resolveSelectedRepository(
  environmentPath: string,
  repositoryKey: string | undefined,
  signal: AbortSignal,
): Promise<string> {
  try {
    return await resolveRepositorySelection(
      environmentPath,
      repositoryKey,
      signal,
      runGit,
    );
  } catch (error) {
    if (signal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${REPOSITORY_UNAVAILABLE_ERROR_PREFIX} ${message}`);
  }
}

async function runSelectedRepositoryOperation<T>(
  environmentPath: string,
  repositoryKey: string | undefined,
  signal: AbortSignal,
  operation: (repositoryRoot: string) => Promise<T>,
): Promise<T> {
  const repositoryRoot = await resolveSelectedRepository(
    environmentPath,
    repositoryKey,
    signal,
  );

  try {
    return await operation(repositoryRoot);
  } catch (operationError) {
    if (signal.aborted) throw operationError;

    try {
      await resolveRepositorySelection(
        environmentPath,
        repositoryKey,
        signal,
        runGit,
      );
    } catch (availabilityError) {
      if (signal.aborted) throw operationError;
      const message = availabilityError instanceof Error
        ? availabilityError.message
        : String(availabilityError);
      throw new Error(`${REPOSITORY_UNAVAILABLE_ERROR_PREFIX} ${message}`);
    }

    throw operationError;
  }
}

function assertObjectName(hash: string): void {
  if (!/^[0-9a-fA-F]{4,64}$/.test(hash)) {
    throw new Error("Git returned an invalid commit hash.");
  }
}

function refKind(fullName: string): GitRef["kind"] {
  if (fullName.startsWith("refs/heads/")) return "local";
  if (fullName.startsWith("refs/remotes/")) return "remote";
  if (fullName.startsWith("refs/tags/")) return "tag";
  if (fullName === "refs/stash") return "stash";
  return "other";
}

function shortRefName(fullName: string): string {
  for (const prefix of ["refs/heads/", "refs/remotes/", "refs/tags/"]) {
    if (fullName.startsWith(prefix)) return fullName.slice(prefix.length);
  }
  if (fullName === "refs/stash") return "stash";
  return fullName.replace(/^refs\//, "");
}

function refPriority(ref: GitRef): number {
  if (ref.isHead) return 0;
  if (ref.kind === "local") return 1;
  if (ref.kind === "tag") return 2;
  if (ref.kind === "remote") return 3;
  if (ref.kind === "stash") return 4;
  return 5;
}

async function readRefs(
  repoRoot: string,
  signal: AbortSignal,
): Promise<{
  byHash: Map<string, GitRef[]>;
  currentBranch: string | null;
  headHash: string | null;
  revision: string;
}> {
  const [rawRefs, rawHead, rawBranch] = await Promise.all([
    runGit(
      repoRoot,
      [
        "for-each-ref",
        "--sort=refname",
        "--format=%(objectname)%00%(*objectname)%00%(refname)%00",
      ],
      signal,
    ),
    runGitOptional(repoRoot, ["rev-parse", "HEAD"], signal),
    runGitOptional(repoRoot, ["symbolic-ref", "--quiet", "HEAD"], signal),
  ]);

  const currentBranchRef = rawBranch?.trim() || null;
  const currentBranch = currentBranchRef
    ? shortRefName(currentBranchRef)
    : null;
  const byHash = new Map<string, GitRef[]>();
  const revisionRecords: string[] = [];
  const fields = rawRefs.split("\0");

  for (let index = 0; index + 2 < fields.length; index += 3) {
    const objectHash = fields[index]?.trim();
    const peeledHash = fields[index + 1]?.trim();
    const fullName = fields[index + 2]?.trim();
    if (!objectHash || !fullName) continue;
    if (isHiddenRef(fullName)) continue;
    revisionRecords.push(`${objectHash}\0${peeledHash ?? ""}\0${fullName}`);

    const hash = peeledHash || objectHash;
    const ref: GitRef = {
      fullName,
      name: shortRefName(fullName),
      kind: refKind(fullName),
      isHead: fullName === currentBranchRef,
    };
    const refs = byHash.get(hash) ?? [];
    refs.push(ref);
    byHash.set(hash, refs);
  }

  const headHash = rawHead?.trim();
  if (headHash) {
    const refs = byHash.get(headHash) ?? [];
    if (!refs.some((ref) => ref.isHead)) {
      refs.push({
        fullName: "HEAD",
        name: "HEAD",
        kind: "other",
        isHead: true,
      });
    }
    byHash.set(headHash, refs);
  }

  for (const refs of byHash.values()) {
    refs.sort((left, right) => {
      const priority = refPriority(left) - refPriority(right);
      return priority || left.name.localeCompare(right.name);
    });
  }

  return {
    byHash,
    currentBranch,
    headHash: headHash ?? null,
    revision: revisionRecords.join("\0"),
  };
}

function parseCommitSummaries(
  raw: string,
  refsByHash: Map<string, GitRef[]>,
): GitCommitSummary[] {
  const fields = raw.split("\0");
  const commits: GitCommitSummary[] = [];

  for (
    let index = 0;
    index + SUMMARY_FIELD_COUNT - 1 < fields.length;
    index += SUMMARY_FIELD_COUNT
  ) {
    const hash = fields[index]?.trim();
    if (!hash) continue;
    const parentField = fields[index + 1] ?? "";

    commits.push({
      hash,
      parents: parentField ? parentField.split(" ").filter(Boolean) : [],
      authorName: fields[index + 2] ?? "",
      authorEmail: fields[index + 3] ?? "",
      authorDate: fields[index + 4] ?? "",
      committerDate: fields[index + 5] ?? "",
      subject: fields[index + 6] ?? "",
      refs: refsByHash.get(hash) ?? [],
    });
  }

  return commits;
}

function parseCommitDetail(
  raw: string,
  refsByHash: Map<string, GitRef[]>,
): (GitCommitSummary & { body: string }) | null {
  const fields = raw.split("\0");
  if (fields.length < DETAIL_FIELD_COUNT) return null;
  const summary = parseCommitSummaries(
    fields.slice(0, SUMMARY_FIELD_COUNT).join("\0") + "\0",
    refsByHash,
  )[0];
  if (!summary) return null;
  return {
    ...summary,
    body: fields[SUMMARY_FIELD_COUNT] ?? "",
  };
}

const SUMMARY_FORMAT = ["%H", "%P", "%an", "%ae", "%aI", "%cI", "%s"].join(
  "%x00",
) + "%x00";

const DETAIL_FORMAT = ["%H", "%P", "%an", "%ae", "%aI", "%cI", "%s", "%b"].join(
  "%x00",
) + "%x00";

function statusName(code: string): GitFileChange["status"] {
  switch (code.at(0)) {
    case "A":
      return "added";
    case "C":
      return "copied";
    case "D":
      return "deleted";
    case "M":
      return "modified";
    case "R":
      return "renamed";
    case "T":
      return "type-changed";
    default:
      return "unknown";
  }
}

function parseNameStatus(raw: string): Map<string, GitFileChange["status"]> {
  const tokens = raw.split("\0").filter(Boolean);
  const statuses = new Map<string, GitFileChange["status"]>();

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? "";
    if (token.includes("\t")) {
      const [code, ...pathParts] = token.split("\t");
      const path = pathParts.join("\t");
      if (path) statuses.set(path, statusName(code ?? ""));
      continue;
    }

    const path = tokens[index + 1];
    if (!path) continue;
    statuses.set(path, statusName(token));
    index += 1;
  }

  return statuses;
}

function parseNumStat(
  raw: string,
  statuses: Map<string, GitFileChange["status"]>,
): GitFileChange[] {
  return raw
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const [rawAdditions, rawDeletions, ...pathParts] = record.split("\t");
      const path = pathParts.join("\t");
      const additions = Number.parseInt(rawAdditions ?? "", 10);
      const deletions = Number.parseInt(rawDeletions ?? "", 10);
      return {
        path,
        status: statuses.get(path) ?? "unknown",
        additions: Number.isFinite(additions) ? additions : null,
        deletions: Number.isFinite(deletions) ? deletions : null,
      };
    })
    .filter((file) => file.path.length > 0);
}

function parseWorkingTreeStatuses(
  raw: string,
): Map<string, GitFileChange["status"]> {
  const statuses = new Map<string, GitFileChange["status"]>();

  for (const record of raw.split("\0")) {
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const path = record.slice(3);
    if (!path) continue;

    let status: GitFileChange["status"] = "unknown";
    if (code.includes("U") || code === "AA" || code === "DD") status = "conflicted";
    else if (code === "??" || code.includes("A")) status = "added";
    else if (code.includes("D")) status = "deleted";
    else if (code.includes("R")) status = "renamed";
    else if (code.includes("C")) status = "copied";
    else if (code.includes("T")) status = "type-changed";
    else if (code.includes("M")) status = "modified";

    statuses.set(path, status);
  }

  return statuses;
}

function buildHistoryRevision(
  headHash: string | null,
  currentBranch: string | null,
  refsRevision: string,
  workingTreeRevision: string,
): string {
  const hash = createHash("sha256");
  for (const value of [
    headHash ?? "",
    currentBranch ?? "",
    refsRevision,
    workingTreeRevision,
  ]) {
    hash.update(`${Buffer.byteLength(value)}:`);
    hash.update(value);
  }
  return hash.digest("hex");
}

async function readWorkingTreeStatus(
  repoRoot: string,
  signal: AbortSignal,
): Promise<string> {
  return runGit(
    repoRoot,
    [
      "-c",
      "status.renames=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
    ],
    signal,
  );
}

async function readWorkingTreeFiles(
  repoRoot: string,
  signal: AbortSignal,
): Promise<{ files: GitFileChange[]; revision: string }> {
  const rawStatus = await readWorkingTreeStatus(repoRoot, signal);
  const statuses = parseWorkingTreeStatuses(rawStatus);
  const revision = await buildWorkingTreeRevision(repoRoot, rawStatus, statuses);
  if (statuses.size === 0) return { files: [], revision };

  const headHash = await runGitOptional(
    repoRoot,
    ["rev-parse", "--verify", "HEAD"],
    signal,
  );

  const rawStats = await runGitOptional(
    repoRoot,
    [
      "diff",
      "--no-renames",
      "--numstat",
      "-z",
      ...(headHash ? ["HEAD"] : ["--cached"]),
      "--",
    ],
    signal,
  );
  const statsByPath = new Map(
    parseNumStat(rawStats ?? "", statuses).map((file) => [file.path, file]),
  );

  return {
    files: Array.from(statuses, ([path, status]) => {
      const stats = statsByPath.get(path);
      return {
        path,
        status,
        additions: stats?.additions ?? null,
        deletions: stats?.deletions ?? null,
      };
    }).sort((left, right) => left.path.localeCompare(right.path)),
    revision,
  };
}

async function buildWorkingTreeRevision(
  repoRoot: string,
  statusRaw: string,
  statuses = parseWorkingTreeStatuses(statusRaw),
): Promise<string> {
  const paths = Array.from(statuses.keys()).sort((left, right) =>
    left.localeCompare(right)
  );
  const metadata = await Promise.all(paths.map(async (path) => {
    try {
      const stats = await lstat(join(repoRoot, path), { bigint: true });
      return [
        path,
        stats.mode,
        stats.size,
        stats.mtimeNs,
        stats.ctimeNs,
      ].join("\0");
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String(error.code)
        : "unknown";
      return `${path}\0${code}`;
    }
  }));
  return `${statusRaw}\0${metadata.join("\0")}`;
}

async function readHistoryRevision(
  repoRoot: string,
  signal: AbortSignal,
): Promise<string> {
  const [refs, statusRaw] = await Promise.all([
    readRefs(repoRoot, signal),
    readWorkingTreeStatus(repoRoot, signal),
  ]);
  const workingTreeRevision = await buildWorkingTreeRevision(repoRoot, statusRaw);
  return buildHistoryRevision(
    refs.headHash,
    refs.currentBranch,
    refs.revision,
    workingTreeRevision,
  );
}

async function readCommitDetails(
  repoRoot: string,
  hash: string,
  signal: AbortSignal,
): Promise<CommitDetails> {
  assertObjectName(hash);
  const { byHash } = await readRefs(repoRoot, signal);
  const rawCommit = await runGit(
    repoRoot,
    ["show", "-s", `--format=${DETAIL_FORMAT}`, hash],
    signal,
  );

  const commit = parseCommitDetail(rawCommit, byHash);
  if (!commit) throw new Error(`Commit ${hash} was not found.`);

  const diffArgs = commit.parents[0]
    ? [commit.parents[0], hash]
    : ["--root", "--no-commit-id", "-r", hash];
  const [rawStatuses, rawStats] = await Promise.all([
    runGit(
      repoRoot,
      ["diff-tree", "--no-renames", "--name-status", "-z", ...diffArgs],
      signal,
    ),
    runGit(
      repoRoot,
      ["diff-tree", "--no-renames", "--numstat", "-z", ...diffArgs],
      signal,
    ),
  ]);

  return {
    ...commit,
    files: parseNumStat(rawStats, parseNameStatus(rawStatuses)),
  };
}

export default experimental_defineHostEntry({
  contract: hostContract,
  handlers: {
    async repositories({ environmentPath }, context) {
      return {
        repositories: await discoverRepositories(
          environmentPath,
          context.signal,
          runGit,
        ),
      };
    },

    async history({ environmentPath, repositoryKey, offset, limit }, context) {
      const repoRoot = await resolveSelectedRepository(
        environmentPath,
        repositoryKey,
        context.signal,
      );
      const [{ byHash, currentBranch, headHash, revision: refsRevision }, rawHistory, rawCount, workingTree] = await Promise.all([
        readRefs(repoRoot, context.signal),
        runGit(
          repoRoot,
          [
            "log",
            ...VISIBLE_HISTORY_REVISIONS,
            "--topo-order",
            `--max-count=${limit + 1}`,
            `--skip=${offset}`,
            `--format=${SUMMARY_FORMAT}`,
          ],
          context.signal,
        ),
        runGit(
          repoRoot,
          ["rev-list", ...VISIBLE_HISTORY_REVISIONS, "--count"],
          context.signal,
        ),
        readWorkingTreeFiles(repoRoot, context.signal),
      ]);

      const parsed = parseCommitSummaries(rawHistory, byHash);
      const hasMore = parsed.length > limit;
      const commits = parsed.slice(0, limit);
      const revision = buildHistoryRevision(
        headHash,
        currentBranch,
        refsRevision,
        workingTree.revision,
      );

      return {
        repoName: basename(repoRoot),
        currentBranch,
        uncommittedFiles: workingTree.files,
        commits,
        offset,
        total: Number.parseInt(rawCount.trim(), 10) || commits.length,
        hasMore,
        revision,
        unavailableReason: null,
      };
    },

    async historyRevision({ environmentPath, repositoryKey }, context) {
      const repoRoot = await resolveSelectedRepository(
        environmentPath,
        repositoryKey,
        context.signal,
      );
      return {
        revision: await readHistoryRevision(repoRoot, context.signal),
        unavailableReason: null,
      };
    },

    async details({ environmentPath, repositoryKey, hash }, context) {
      return runSelectedRepositoryOperation(
        environmentPath,
        repositoryKey,
        context.signal,
        (repoRoot) => readCommitDetails(repoRoot, hash, context.signal),
      );
    },

    async patch({ environmentPath, repositoryKey, hash, path }, context) {
      return runSelectedRepositoryOperation(
        environmentPath,
        repositoryKey,
        context.signal,
        async (repoRoot) => {
          assertObjectName(hash);
          const rawPatch = await runGit(
            repoRoot,
            [
              "show",
              "--format=",
              "--no-color",
              "--no-ext-diff",
              "--first-parent",
              "--unified=3",
              hash,
              "--",
              path,
            ],
            context.signal,
          );
          const truncated = rawPatch.length > MAX_PATCH_CHARS;
          return {
            path,
            patch: truncated ? rawPatch.slice(0, MAX_PATCH_CHARS) : rawPatch,
            truncated,
          };
        },
      );
    },

    async workingPatch({ environmentPath, repositoryKey, path }, context) {
      return runSelectedRepositoryOperation(
        environmentPath,
        repositoryKey,
        context.signal,
        async (repoRoot) => {
          const { files } = await readWorkingTreeFiles(repoRoot, context.signal);
          if (!files.some((file) => file.path === path)) {
            throw new Error(`Uncommitted file ${path} was not found.`);
          }

          const [headHash, trackedPath] = await Promise.all([
            runGitOptional(
              repoRoot,
              ["rev-parse", "--verify", "HEAD"],
              context.signal,
            ),
            runGitOptional(
              repoRoot,
              ["ls-files", "--error-unmatch", "--", path],
              context.signal,
            ),
          ]);
          const rawPatch = headHash && trackedPath !== null
            ? await runGit(
              repoRoot,
              [
                "diff",
                "--no-renames",
                "--no-color",
                "--no-ext-diff",
                "--unified=3",
                "HEAD",
                "--",
                path,
              ],
              context.signal,
            )
            : await runGit(
              repoRoot,
              [
                "diff",
                "--no-index",
                "--no-color",
                "--no-ext-diff",
                "--unified=3",
                "--",
                "/dev/null",
                path,
              ],
              context.signal,
              [1],
            );
          const truncated = rawPatch.length > MAX_PATCH_CHARS;
          return {
            path,
            patch: truncated ? rawPatch.slice(0, MAX_PATCH_CHARS) : rawPatch,
            truncated,
          };
        },
      );
    },
  },
});
