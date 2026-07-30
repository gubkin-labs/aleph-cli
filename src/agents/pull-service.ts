import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { createApiClient } from "../api/client.js";
import { ApiError, CliError } from "../errors.js";
import type { Output } from "../output.js";
import { agentsApi } from "./agents-api.js";
import {
  type AgentManifest,
  readAgentManifest,
  resolveSafeChild,
  writeAgentManifest,
} from "./manifest.js";

type ApiClient = ReturnType<typeof createApiClient>;

export interface PullResult {
  readonly agentId: string;
  readonly directory: string;
  readonly fileCount: number;
  readonly versionId: string;
}

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
}): Promise<PullResult> => {
  const absolute = resolve(input.directory);
  const manifest: AgentManifest = await readAgentManifest(absolute);
  input.output.progress(`Pulling ${manifest.agentId}`);

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
    versionId,
  };
};
