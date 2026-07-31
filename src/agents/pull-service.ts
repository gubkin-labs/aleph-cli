import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { z } from "zod";

import type { createApiClient } from "../api/client.js";
import { ApiError, CliError } from "../errors.js";
import type { Output } from "../output.js";
import { agentsApi } from "./agents-api.js";
import { discoverBundles } from "./discover.js";
import {
  type AgentManifest,
  readAgentManifest,
  repositoryManifestSchema,
  resolveSafeChild,
  writeAgentManifest,
} from "./manifest.js";

type ApiClient = ReturnType<typeof createApiClient>;

export const pullOptionsSchema = z.object({
  continueOnError: z.boolean().default(false),
  /**
   * Only write live pin/latest `versionId` into aleph.json.
   * Leaves local bundle files unchanged (keeps in-progress edits).
   */
  stampVersionId: z.boolean().default(false),
});

export type PullOptions = z.infer<typeof pullOptionsSchema>;

export interface PullResult {
  readonly agentId: string;
  readonly directory: string;
  readonly fileCount: number;
  readonly status: "pulled" | "stamped";
  readonly versionId: string;
}

export interface PullBundlesResult {
  readonly agentId?: string;
  readonly directory: string;
  readonly error?: string;
  readonly fileCount?: number;
  readonly status: "failed" | "pulled" | "stamped";
  readonly versionId?: string;
}

const exists = async (path: string): Promise<boolean> =>
  stat(path)
    .then(() => true)
    .catch(() => false);

export const resolvePullTargets = async (
  inputDirectory: string
): Promise<{ readonly bundles: string[]; readonly stateRoot: string }> => {
  const root = resolve(inputDirectory);
  const manifestPath = resolve(root, "aleph.json");
  if (await exists(manifestPath)) {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    const repository = repositoryManifestSchema.safeParse(parsed);
    if (repository.success) {
      return {
        bundles: repository.data.agents.map((path) =>
          resolveSafeChild(root, path)
        ),
        stateRoot: root,
      };
    }
    await readAgentManifest(root);
    return { bundles: [root], stateRoot: root };
  }
  return discoverBundles(root);
};

const resolvePullVersionId = async (
  client: ApiClient,
  agent: Awaited<ReturnType<typeof agentsApi.get>>
): Promise<string> => {
  if (agent.pinnedVersionId) {
    return agent.pinnedVersionId;
  }
  const versions = await agentsApi.listVersions(client, agent.id);
  const latest = versions.data[0];
  if (!latest) {
    throw new CliError(
      `Agent ${agent.id} has no versions to pull. Publish a version before running pull.`
    );
  }
  return latest.id;
};

const writePulledFiles = async (
  directory: string,
  files: Awaited<ReturnType<typeof agentsApi.downloadVersionFiles>>,
  icon: string | undefined
): Promise<number> => {
  let written = 0;
  for (const file of files) {
    if (file.path === "aleph.json" || (icon && file.path === icon)) {
      continue;
    }
    const absolute = resolveSafeChild(directory, file.path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, file.bytes);
    written += 1;
  }
  return written;
};

export const pullBundle = async (input: {
  readonly client: ApiClient;
  readonly directory: string;
  readonly output: Output;
  readonly stampVersionId?: boolean;
}): Promise<PullResult> => {
  const absolute = resolve(input.directory);
  const manifest: AgentManifest = await readAgentManifest(absolute);
  const stampOnly = Boolean(input.stampVersionId);
  input.output.progress(
    stampOnly
      ? `Stamping versionId for ${manifest.agentId}`
      : `Pulling ${manifest.agentId}`
  );

  let agent: Awaited<ReturnType<typeof agentsApi.get>>;
  try {
    agent = await agentsApi.get(input.client, manifest.agentId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new CliError(
        `Agent ${manifest.agentId} was not found. Create it with \`aleph agents push\` before pull.`
      );
    }
    throw error;
  }

  const versionId = await resolvePullVersionId(input.client, agent);
  if (stampOnly) {
    await writeAgentManifest(absolute, { ...manifest, versionId });
    return {
      agentId: agent.id,
      directory: absolute,
      fileCount: 0,
      status: "stamped",
      versionId,
    };
  }

  const files = await agentsApi.downloadVersionFiles(
    input.client,
    agent.id,
    versionId
  );
  const fileCount = await writePulledFiles(absolute, files, manifest.icon);
  await writeAgentManifest(absolute, { ...manifest, versionId });

  return {
    agentId: agent.id,
    directory: absolute,
    fileCount,
    status: "pulled",
    versionId,
  };
};

export const pullBundles = async (input: {
  readonly client: ApiClient;
  readonly directory: string;
  readonly options?: PullOptions;
  readonly output: Output;
}): Promise<PullBundlesResult[]> => {
  const options = pullOptionsSchema.parse(input.options ?? {});
  const { bundles, stateRoot } = await resolvePullTargets(input.directory);
  if (bundles.length === 0) {
    throw new CliError(
      `No agent bundles found under ${resolve(input.directory)}`
    );
  }

  const results: PullBundlesResult[] = [];
  for (const bundle of bundles) {
    const displayDirectory = relative(stateRoot, bundle) || ".";
    try {
      const pulled = await pullBundle({
        client: input.client,
        directory: bundle,
        output: input.output,
        stampVersionId: options.stampVersionId,
      });
      results.push({
        agentId: pulled.agentId,
        directory: displayDirectory,
        fileCount: pulled.fileCount,
        status: pulled.status,
        versionId: pulled.versionId,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!options.continueOnError) {
        throw error;
      }
      input.output.error(message);
      results.push({
        directory: displayDirectory,
        error: message,
        status: "failed",
      });
    }
  }
  return results;
};
