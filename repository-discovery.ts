import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { RepositoryDescriptor } from "./contracts";

const MAX_GIT_OUTPUT_BYTES = 32 * 1024 * 1024;

export type GitRunner = (
  cwd: string,
  args: string[],
  signal: AbortSignal,
  acceptedExitCodes?: readonly number[],
) => Promise<string>;

export function runGit(
  cwd: string,
  args: string[],
  signal: AbortSignal,
  acceptedExitCodes: readonly number[] = [],
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        signal,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const exitCode = error && typeof error.code === "number" ? error.code : null;
        if (error && (exitCode === null || !acceptedExitCodes.includes(exitCode))) {
          const detail = stderr.trim();
          reject(new Error(detail || error.message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function isInside(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === "" ||
    (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot))
  );
}

function repositoryKey(root: string, repositoryPath: string): string {
  const pathFromRoot = relative(root, repositoryPath);
  return pathFromRoot === "" ? "." : pathFromRoot.split(sep).join("/");
}

async function gitTopLevel(
  candidate: string,
  signal: AbortSignal,
  run: GitRunner,
): Promise<string | undefined> {
  try {
    const output = await run(candidate, ["rev-parse", "--show-toplevel"], signal);
    return await realpath(output.replace(/[\r\n]+$/, ""));
  } catch (error) {
    if (signal.aborted) throw error;
    return undefined;
  }
}

async function isRepository(
  candidate: string,
  signal: AbortSignal,
  run: GitRunner,
): Promise<boolean> {
  return (await gitTopLevel(candidate, signal, run)) === candidate;
}

type ValidatedRepository = RepositoryDescriptor & { canonicalPath: string };

type RepositoryDiscovery = {
  environmentRoot: string;
  /** Directory whose immediate children are repositories; undefined for a root worktree. */
  repositoriesDirectory: string | undefined;
  /** "repos": children of environmentRoot/repos; "children": children of environmentRoot itself. */
  layout: "root" | "repos" | "children";
  repositories: ValidatedRepository[];
};

/** Folders never scanned as repositories when falling back to the root's children. */
function isSkippedChild(name: string): boolean {
  return name.startsWith(".") || name === "node_modules";
}

async function discoverValidatedRepositories(
  environmentPath: string,
  signal: AbortSignal,
  run: GitRunner,
): Promise<RepositoryDiscovery> {
  const environmentRoot = await realpath(environmentPath);

  if (await isRepository(environmentRoot, signal, run)) {
    return {
      environmentRoot,
      repositoriesDirectory: undefined,
      layout: "root",
      repositories: [
        {
          key: ".",
          name: basename(environmentRoot),
          canonicalPath: environmentRoot,
        },
      ],
    };
  }

  let repositoriesDirectory: string;
  let entries: Dirent<string>[];
  let layout: RepositoryDiscovery["layout"] = "repos";
  try {
    repositoriesDirectory = await realpath(resolve(environmentRoot, "repos"));
    entries = await readdir(repositoriesDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    // No repos/ directory: a workspace that simply holds several checkouts side by
    // side (e.g. a plugins folder). Its immediate, non-hidden children are candidates.
    layout = "children";
    repositoriesDirectory = environmentRoot;
    try {
      entries = (await readdir(environmentRoot, { withFileTypes: true })).filter(
        (entry) => !isSkippedChild(entry.name),
      );
    } catch {
      return { environmentRoot, repositoriesDirectory: undefined, layout: "root", repositories: [] };
    }
  }

  const discovered = new Map<string, ValidatedRepository>();
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;

    try {
      const candidate = await realpath(resolve(repositoriesDirectory, entry.name));
      if (!isInside(environmentRoot, candidate)) continue;
      if (dirname(candidate) !== repositoriesDirectory) continue;
      if (!(await isRepository(candidate, signal, run))) continue;

      const key = repositoryKey(environmentRoot, candidate);
      discovered.set(candidate, {
        key,
        name: basename(candidate),
        canonicalPath: candidate,
      });
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }

  return {
    environmentRoot,
    repositoriesDirectory,
    layout,
    repositories: [...discovered.values()].sort((left, right) =>
      left.key < right.key
        ? -1
        : left.key > right.key
          ? 1
          : 0,
    ),
  };
}

export async function discoverRepositories(
  environmentPath: string,
  signal: AbortSignal,
  run: GitRunner,
): Promise<RepositoryDescriptor[]> {
  const discovery = await discoverValidatedRepositories(environmentPath, signal, run);
  const summaries = new Array<RepositoryDescriptor>(discovery.repositories.length);
  let nextRepository = 0;
  const workerCount = Math.min(8, discovery.repositories.length);

  const workers = Array.from({ length: workerCount }, async () => {
    while (nextRepository < discovery.repositories.length) {
      const index = nextRepository++;
      const repository = discovery.repositories[index]!;
      const { canonicalPath, ...descriptor } = repository;
      try {
        const status = await run(
          canonicalPath,
          ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
          signal,
        );
        let currentBranch: string | null = null;
        let dirtyCount = 0;
        for (const record of status.split("\0")) {
          if (record.startsWith("# branch.head ")) {
            const branch = record.slice("# branch.head ".length);
            currentBranch = branch === "(detached)" ? null : branch;
          } else if (/^[12u?] /.test(record)) {
            dirtyCount += 1;
          }
        }
        summaries[index] = { ...descriptor, currentBranch, dirtyCount };
      } catch (error) {
        if (signal.aborted) throw error;
        summaries[index] = { ...descriptor, currentBranch: null, dirtyCount: null };
      }
    }
  });

  await Promise.all(workers);
  return summaries;
}

function isRelativeRepositoryKey(repositoryKey: string): boolean {
  return (
    repositoryKey.length > 0 &&
    !isAbsolute(repositoryKey) &&
    !repositoryKey.split(/[\\/]/).includes("..")
  );
}

async function revalidateSelection(
  environmentPath: string,
  discovery: RepositoryDiscovery,
  selected: ValidatedRepository,
  signal: AbortSignal,
  run: GitRunner,
): Promise<string> {
  try {
    const environmentRoot = await realpath(environmentPath);
    if (environmentRoot !== discovery.environmentRoot) {
      throw new Error("environment changed");
    }

    const candidate = await realpath(resolve(environmentRoot, selected.key));
    if (candidate !== selected.canonicalPath || !isInside(environmentRoot, candidate)) {
      throw new Error("candidate changed");
    }

    if (discovery.layout === "root" || discovery.repositoriesDirectory === undefined) {
      if (candidate !== environmentRoot) throw new Error("root repository changed");
    } else if (discovery.layout === "children") {
      if (dirname(candidate) !== environmentRoot || candidate === environmentRoot) {
        throw new Error("repository directory changed");
      }
    } else {
      const repositoriesDirectory = await realpath(resolve(environmentRoot, "repos"));
      if (
        repositoriesDirectory !== discovery.repositoriesDirectory ||
        dirname(candidate) !== repositoriesDirectory
      ) {
        throw new Error("repository directory changed");
      }
    }

    if (!(await isRepository(candidate, signal, run))) {
      throw new Error("repository changed");
    }
    return candidate;
  } catch (error) {
    if (signal.aborted) throw error;
    throw new Error("Invalid repository selection.");
  }
}

export async function resolveRepositorySelection(
  environmentPath: string,
  repositoryKey: string | undefined,
  signal: AbortSignal,
  run: GitRunner,
): Promise<string> {
  const discovery = await discoverValidatedRepositories(environmentPath, signal, run);
  const { repositories } = discovery;
  let selected: ValidatedRepository;

  if (repositoryKey === undefined) {
    if (repositories.length === 1) {
      selected = repositories[0]!;
    } else {
      throw new Error("Repository selection requires an explicit repository key.");
    }
  } else {
    if (!isRelativeRepositoryKey(repositoryKey)) {
      throw new Error("Invalid repository selection.");
    }

    const matchingRepository = repositories.find(
      (repository) => repository.key === repositoryKey,
    );
    if (!matchingRepository) throw new Error("Invalid repository selection.");
    selected = matchingRepository;
  }

  return revalidateSelection(environmentPath, discovery, selected, signal, run);
}
