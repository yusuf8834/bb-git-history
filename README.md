# Git History for bb

Git History adds a compact, read-only commit graph to a thread's right panel.
It reads repository refs, so the graph includes local branches,
remote-tracking branches, tags, stashes, and shared worktree history.

![Git History panel open in bb](assets/git-history.jpeg)

## Install

Install the latest compatible release from GitHub:

```sh
bb plugin install git:https://github.com/yusuf8834/bb-git-history.git@^0.4.1
```

For local development:

```sh
npm install --include=dev
npm run build
bb plugin install .
```

Open a project thread and select Git History from the right panel's Actions
list. Enable **Show thread header shortcut** in the plugin settings if you also
want a Git folder button beside the editor controls.

## What it shows

- Topologically ordered commits across repository refs
- Experimental branch and merge lanes using the compact history style
- Local, remote, tag, stash, and `HEAD` labels
- Commit author, date, full message, and first-parent changed files
- Per-file patches rendered by bb's native diff viewer
- Collapsible uncommitted-file list with working-tree diffs
- Infinite loading with virtualized rows

The experimental commit graph is enabled by default. Turn off **Experimental
commit graph** in the plugin settings to return to the single history rail.

The plugin does not run checkout, reset, merge, rebase, or other Git mutations.
Commits reachable only through reflogs are not part of the main graph.

## Repository selection

Git History discovers repositories from the thread environment using one of two
exclusive modes:

- When the environment root is itself a Git worktree, it is the only repository
  shown. The existing single-repository panel is used and no repository navigator
  is displayed.
- Otherwise, Git History considers only canonical Git worktrees that are
  immediate children of the environment's `repos/` directory. Discovery is not
  recursive: nested repositories, non-Git directories, and paths that resolve
  outside the environment are not available for selection.

For multiple repositories, the expected folder structure is:

```text
workspace/                 # Thread environment root, without its own .git
  repos/                   # This directory must be named repos
    project-a/
      .git
    project-b/
      .git
```

When the environment root is not a Git worktree and has no `repos/` directory,
Git History falls back to the root's immediate, non-hidden child folders that
are Git worktrees (for example `workspace/project-a/`); `node_modules` and dot
folders are skipped. A `repos/` directory, when present, still takes precedence.

The `.git` entry may be a directory or a worktree's `.git` file. Deeper paths,
such as `workspace/repos/group/project-a/`, are not discovered. If `workspace/`
is itself a Git worktree, only that root repository is shown.

Each discovered repository has an independent history; Git History never merges
commits, details, or patches from different repositories. When more than one
repository is available, a collapsible repository navigator shows each branch
and working-tree status. Selecting a row switches the complete history below and
scopes commit details, commit-file patches, and working-tree patches to that
repository. The selection is remembered per thread. Large repository lists are
height-limited and add name/branch search after eight repositories.

## Development

```sh
npm test
npx tsc --noEmit
npm run build
```

The host entry runs Git on the thread environment's bb host. This keeps the
same behavior for local worktrees and repositories on connected machines.

## License

[MIT](LICENSE)
