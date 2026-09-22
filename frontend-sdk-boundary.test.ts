import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const IMPORT_PATTERN = /^import\s+(?:(type)\s+)?(?:[^;]*?\s+from\s+)?["']([^"']+)["']/gm;
const SDK_ROOT_ENTRY = "@get-bb/plugin-sdk";
const CANDIDATE_SUFFIXES = ["", ".ts", ".tsx", "/index.ts", "/index.tsx"];

function resolveModule(specifier: string, importer: string): string | null {
  const base = specifier.startsWith("@/")
    ? resolve(specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(importer), specifier)
      : null;
  if (base === null) return null;
  for (const suffix of CANDIDATE_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (candidate.endsWith(".css")) return null;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Walks the runtime module graph reachable from `entry`, following only value
 * imports, and returns the files that import the SDK root entry from it.
 */
function sdkImportersReachableFrom(entry: string): string[] {
  const visited = new Set<string>();
  const importers = new Set<string>();
  const queue = [resolve(entry)];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (visited.has(file)) continue;
    visited.add(file);
    for (const [, typeOnly, specifier] of readFileSync(file, "utf8").matchAll(IMPORT_PATTERN)) {
      if (typeOnly !== undefined) continue;
      if (specifier === SDK_ROOT_ENTRY) {
        importers.add(file);
        continue;
      }
      const resolved = resolveModule(specifier, file);
      if (resolved !== null) queue.push(resolved);
    }
  }
  return [...importers];
}

describe("frontend bundle boundary", () => {
  it("keeps the SDK root entry out of the app bundle", () => {
    expect(sdkImportersReachableFrom("app.tsx")).toEqual([]);
  });
});
