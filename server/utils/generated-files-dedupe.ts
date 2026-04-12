import type { GeneratedFile } from "@shared/schema";

/** Normalized basename (last segment, lowercased) for deduplication. */
export function fileBasenameKey(fileName: string): string {
  const base = fileName.replace(/^\/+|\/+$/g, "").split("/").pop() || fileName;
  return base.toLowerCase();
}

/**
 * Session storage allows duplicate rows for the same logical file path.
 * Keep the newest row per basename; return IDs of older duplicates to delete.
 */
export function dedupeGeneratedFilesKeepNewest(files: GeneratedFile[]): {
  kept: GeneratedFile[];
  removeIds: string[];
} {
  const byKey = new Map<string, GeneratedFile[]>();
  for (const f of files) {
    const key = fileBasenameKey(f.fileName);
    let arr = byKey.get(key);
    if (!arr) {
      arr = [];
      byKey.set(key, arr);
    }
    arr.push(f);
  }
  const kept: GeneratedFile[] = [];
  const removeIds: string[] = [];
  for (const [, group] of Array.from(byKey.entries())) {
    if (group.length === 1) {
      kept.push(group[0]);
      continue;
    }
    group.sort((a: GeneratedFile, b: GeneratedFile) => {
      const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      if (tb !== ta) return tb - ta;
      return b.id.localeCompare(a.id);
    });
    kept.push(group[0]);
    for (let i = 1; i < group.length; i++) {
      removeIds.push(group[i].id);
    }
  }
  kept.sort((a, b) => a.fileName.localeCompare(b.fileName));
  return { kept, removeIds };
}
