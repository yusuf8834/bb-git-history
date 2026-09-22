import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const gitRefSchema = z
  .object({
    fullName: z.string(),
    name: z.string(),
    kind: z.enum(["local", "remote", "tag", "stash", "other"]),
    isHead: z.boolean(),
  })
  .strict();

export const gitCommitSummarySchema = z
  .object({
    hash: z.string(),
    parents: z.array(z.string()),
    authorName: z.string(),
    authorEmail: z.string(),
    authorDate: z.string(),
    committerDate: z.string(),
    subject: z.string(),
    refs: z.array(gitRefSchema),
  })
  .strict();

export const gitFileChangeSchema = z
  .object({
    path: z.string(),
    status: z.enum([
      "added",
      "conflicted",
      "copied",
      "deleted",
      "modified",
      "renamed",
      "type-changed",
      "unknown",
    ]),
    additions: z.number().int().nonnegative().nullable(),
    deletions: z.number().int().nonnegative().nullable(),
  })
  .strict();

export const historyPageSchema = z
  .object({
    repoName: z.string(),
    currentBranch: z.string().nullable(),
    uncommittedFiles: z.array(gitFileChangeSchema),
    commits: z.array(gitCommitSummarySchema),
    offset: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    hasMore: z.boolean(),
    revision: z.string(),
    unavailableReason: z.string().nullable(),
  })
  .strict();

export const historyRevisionSchema = z
  .object({
    revision: z.string(),
    unavailableReason: z.string().nullable(),
  })
  .strict();

export const commitDetailsSchema = gitCommitSummarySchema.extend({
  body: z.string(),
  files: z.array(gitFileChangeSchema),
});

export const commitPatchSchema = z
  .object({
    path: z.string(),
    patch: z.string(),
    truncated: z.boolean(),
  })
  .strict();

export const repositoryDescriptorSchema = z
  .object({
    key: z.string().min(1).max(16_384),
    name: z.string().min(1).max(512),
    currentBranch: z.string().nullable().optional(),
    dirtyCount: z.number().int().nonnegative().nullable().optional(),
  })
  .strict();

export const repositorySelectionSchema = z
  .object({
    environmentPath: z.string().min(1).max(16_384),
    repositoryKey: z.string().min(1).max(16_384).optional(),
  })
  .strict();

const threadRepositorySchema = z
  .object({
    threadId: z.string().min(1),
    repositoryKey: z.string().min(1).max(16_384).optional(),
  })
  .strict();

const threadHistoryInputSchema = threadRepositorySchema.extend({
    offset: z.number().int().nonnegative(),
    limit: z.number().int().min(1).max(400),
  });

const threadCommitInputSchema = threadRepositorySchema.extend({
    hash: z.string().min(4).max(128),
  });

const threadWorkingTreeInputSchema = threadRepositorySchema.extend({
    path: z.string().min(1).max(16_384),
  });

export const rpcContract = defineRpcContract({
  repositories: {
    input: z.object({ threadId: z.string().min(1) }).strict(),
    output: z.object({
      repositories: z.array(repositoryDescriptorSchema),
      unavailableReason: z.string().nullable(),
    }).strict(),
  },
  history: {
    input: threadHistoryInputSchema,
    output: historyPageSchema,
  },
  historyRevision: {
    input: threadRepositorySchema,
    output: historyRevisionSchema,
  },
  details: {
    input: threadCommitInputSchema,
    output: commitDetailsSchema,
  },
  patch: {
    input: threadCommitInputSchema.extend({ path: z.string().min(1).max(16_384) }),
    output: commitPatchSchema,
  },
  workingPatch: {
    input: threadWorkingTreeInputSchema,
    output: commitPatchSchema,
  },
});

export const hostContract = defineRpcContract({
  repositories: {
    input: z.object({
      environmentPath: z.string().min(1).max(16_384),
    }).strict(),
    output: z.object({
      repositories: z.array(repositoryDescriptorSchema),
    }).strict(),
  },
  history: {
    input: repositorySelectionSchema.extend({
      offset: z.number().int().nonnegative(),
      limit: z.number().int().min(1).max(400),
    }),
    output: historyPageSchema,
  },
  historyRevision: {
    input: repositorySelectionSchema,
    output: historyRevisionSchema,
  },
  details: {
    input: repositorySelectionSchema.extend({
      hash: z.string().min(4).max(128),
    }),
    output: commitDetailsSchema,
  },
  patch: {
    input: repositorySelectionSchema.extend({
      hash: z.string().min(4).max(128),
      path: z.string().min(1).max(16_384),
    }),
    output: commitPatchSchema,
  },
  workingPatch: {
    input: repositorySelectionSchema.extend({
      path: z.string().min(1).max(16_384),
    }),
    output: commitPatchSchema,
  },
});

export type GitRef = z.infer<typeof gitRefSchema>;
export type GitCommitSummary = z.infer<typeof gitCommitSummarySchema>;
export type GitFileChange = z.infer<typeof gitFileChangeSchema>;
export type HistoryPage = z.infer<typeof historyPageSchema>;
export type HistoryRevision = z.infer<typeof historyRevisionSchema>;
export type CommitDetails = z.infer<typeof commitDetailsSchema>;
export type CommitPatch = z.infer<typeof commitPatchSchema>;
export type RepositoryDescriptor = z.infer<typeof repositoryDescriptorSchema>;
