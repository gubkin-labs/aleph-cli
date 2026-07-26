import { readdir, readFile, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const excludedDirectories = new Set([
  ".aleph",
  ".git",
  ".next",
  "coverage",
  "dist",
  "node_modules",
  "release",
]);

export interface BundleFile {
  readonly bytes: Uint8Array;
  readonly path: string;
}

const normalize = (value: string): string => value.split(sep).join("/");

export const collectBundleFiles = async (
  directory: string,
  icon?: string
): Promise<BundleFile[]> => {
  const root = await realpath(resolve(directory));
  const files: BundleFile[] = [];

  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const absolute = join(current, entry.name);
      if (entry.isDirectory()) {
        if (!excludedDirectories.has(entry.name)) {
          await walk(absolute);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const path = normalize(relative(root, absolute));
      if (path === "aleph.json" || path === icon || path === ".DS_Store") {
        continue;
      }
      files.push({ bytes: await readFile(absolute), path });
    }
  };

  await walk(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
};
