import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { repositoryManifestSchema, resolveSafeChild } from "./manifest.js";

const exists = async (path: string): Promise<boolean> =>
  stat(path)
    .then(() => true)
    .catch(() => false);

const childManifestDirectories = async (root: string): Promise<string[]> => {
  const entries = await readdir(root, { withFileTypes: true });
  const directories: string[] = [];
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      entry.name.startsWith(".")
    ) {
      continue;
    }
    const directory = join(root, entry.name);
    if (await exists(join(directory, "aleph.json"))) {
      directories.push(directory);
    }
  }
  return directories.sort();
};

export interface DiscoveredBundles {
  readonly bundles: string[];
  readonly stateRoot: string;
}

export const discoverBundles = async (
  inputDirectory: string
): Promise<DiscoveredBundles> => {
  const root = resolve(inputDirectory);
  const rootManifestPath = join(root, "aleph.json");
  if (await exists(rootManifestPath)) {
    const parsed: unknown = JSON.parse(
      await readFile(rootManifestPath, "utf8")
    );
    const repository = repositoryManifestSchema.safeParse(parsed);
    if (repository.success) {
      return {
        bundles: repository.data.agents.map((path) =>
          resolveSafeChild(root, path)
        ),
        stateRoot: root,
      };
    }
  }

  const nestedAgents = join(root, "agents");
  if (await exists(nestedAgents)) {
    return {
      bundles: await childManifestDirectories(nestedAgents),
      stateRoot: root,
    };
  }

  const bundles = await childManifestDirectories(root);
  if (bundles.length > 0) {
    return {
      bundles,
      stateRoot: basename(root) === "agents" ? dirname(root) : root,
    };
  }

  throw new Error(`No agent bundles found under ${root}`);
};
