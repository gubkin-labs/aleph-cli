import { basename, relative, resolve } from "node:path";

import pLimit from "p-limit";
import { z } from "zod";

import type { createApiClient } from "../api/client.js";
import { ApiError, CliError } from "../errors.js";
import type { Output } from "../output.js";
import { agentsApi } from "./agents-api.js";
import { collectBundleFiles } from "./files.js";
import type { AgentManifest } from "./manifest.js";
import {
  hashAgentManifest,
  readAgentManifest,
  writeAgentManifest,
} from "./manifest.js";
import {
  type AgentState,
  bundleStateKey,
  loadState,
  removeStateAgentId,
  saveState,
  setStateAgentId,
} from "./state.js";

type ApiClient = ReturnType<typeof createApiClient>;
const PATH_SEPARATOR_PATTERN = /[\\/]/u;

export const syncOptionsSchema = z.object({
  concurrency: z.coerce.number().int().positive().max(16).default(1),
  continueOnError: z.boolean().default(false),
  dryRun: z.boolean().default(false),
  enable: z.boolean().default(true),
  message: z.string().min(1).optional(),
});

export type SyncOptions = z.infer<typeof syncOptionsSchema>;

export interface SyncResult {
  readonly agentId?: string;
  readonly directory: string;
  readonly error?: string;
  readonly status: "created" | "updated" | "unchanged" | "planned" | "failed";
  readonly versionId?: string;
}

const defaultMessage = (): string => {
  const sha = process.env.GITHUB_SHA?.trim().slice(0, 7);
  return sha ? `sync from git ${sha}` : `sync ${new Date().toISOString()}`;
};

const withResolvedIconUrl = (
  manifest: AgentManifest,
  stateRoot: string,
  bundleDirectory: string
): AgentManifest => {
  if (manifest.iconUrl || !manifest.icon) {
    return manifest;
  }
  const repository = process.env.GITHUB_REPOSITORY?.trim();
  if (!repository) {
    return manifest;
  }
  const ref = process.env.GITHUB_SHA?.trim() || "main";
  const iconPath = relative(stateRoot, resolve(bundleDirectory, manifest.icon))
    .split(PATH_SEPARATOR_PATTERN)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return {
    ...manifest,
    iconUrl: `https://cdn.jsdelivr.net/gh/${repository}@${ref}/${iconPath}`,
  };
};

const pullGuidance = (directory: string): string =>
  `Do not edit versionId by hand. Run \`aleph agents pull ${directory}\` to download live files + stamp versionId, or \`aleph agents pull ${directory} --stamp-version-id\` to only stamp versionId and keep local edits (or \`aleph agents pull\` / \`aleph agents pull --stamp-version-id\` from the repo root), then re-run push/sync.`;

const assertSyncVersionGate = (input: {
  readonly agent: Awaited<ReturnType<typeof agentsApi.get>>;
  readonly directory: string;
  readonly manifest: AgentManifest;
}): void => {
  if (!input.manifest.versionId) {
    throw new CliError(
      `Agent ${input.manifest.agentId} exists remotely but ${input.directory}/aleph.json has no versionId. ${pullGuidance(input.directory)}`
    );
  }
  if (
    input.agent.mode === "enabled" &&
    input.agent.pinnedVersionId &&
    input.agent.pinnedVersionId !== input.manifest.versionId
  ) {
    throw new CliError(
      `Agent ${input.manifest.agentId} is enabled on pin ${input.agent.pinnedVersionId}, but aleph.json has versionId ${input.manifest.versionId}. ${pullGuidance(input.directory)}`
    );
  }
};

const getRemoteAgent = async (
  client: ApiClient,
  agentId: string
): Promise<Awaited<ReturnType<typeof agentsApi.get>> | null> => {
  try {
    return await agentsApi.get(client, agentId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
};

/**
 * After a new version upload: create path respects `--no-enable`; existing
 * agents keep enabled/disabled (repin when already enabled or `--enable`).
 */
const applySyncLifecycle = async (input: {
  readonly client: ApiClient;
  readonly created: boolean;
  readonly enable: boolean;
  readonly existingMode: string | undefined;
  readonly agentId: string;
  readonly versionId: string;
}): Promise<void> => {
  if (input.created) {
    if (input.enable) {
      await agentsApi.enable(input.client, input.agentId, input.versionId);
      return;
    }
    await agentsApi.disable(input.client, input.agentId);
    return;
  }
  if (input.enable || input.existingMode === "enabled") {
    await agentsApi.enable(input.client, input.agentId, input.versionId);
  }
};

const isArchivedAgent = (
  agent: Awaited<ReturnType<typeof agentsApi.get>> | null
): boolean => Boolean(agent?.archivedAt);

const unarchiveExistingAgent = async (input: {
  readonly agent: Awaited<ReturnType<typeof agentsApi.get>>;
  readonly client: ApiClient;
  readonly name: string;
  readonly output: Output;
}): Promise<Awaited<ReturnType<typeof agentsApi.get>>> => {
  input.output.progress(
    `Agent ${input.agent.id} for ${input.name} is archived; unarchiving it`
  );
  return await agentsApi.unarchive(input.client, input.agent.id);
};

const updateOrCreateAgent = async (input: {
  readonly client: ApiClient;
  readonly existing: Awaited<ReturnType<typeof agentsApi.get>> | null;
  readonly manifest: AgentManifest;
  readonly name: string;
  readonly output: Output;
}): Promise<{
  readonly agent: Awaited<ReturnType<typeof agentsApi.create>>;
  readonly created: boolean;
}> => {
  if (input.existing) {
    if (isArchivedAgent(input.existing)) {
      await unarchiveExistingAgent({
        agent: input.existing,
        client: input.client,
        name: input.name,
        output: input.output,
      });
    }
    return {
      agent: await agentsApi.update(
        input.client,
        input.manifest.agentId,
        input.manifest
      ),
      created: false,
    };
  }
  input.output.progress(
    `Agent ${input.manifest.agentId} for ${input.name} does not exist; creating it with the manifest ID`
  );
  try {
    return {
      agent: await agentsApi.create(input.client, input.manifest),
      created: true,
    };
  } catch (error) {
    if (
      !(
        error instanceof ApiError &&
        error.status === 409 &&
        error.message.includes("Agent ID already exists")
      )
    ) {
      throw error;
    }
    // Same UUID still exists (often archived) but GET looked missing — e.g.
    // temporary auth/visibility mismatch. Recover by unarchive + update.
    input.output.progress(
      `Agent ${input.manifest.agentId} for ${input.name} already exists; attempting unarchive + update`
    );
    try {
      await agentsApi.unarchive(input.client, input.manifest.agentId);
    } catch (unarchiveError) {
      if (
        !(unarchiveError instanceof ApiError && unarchiveError.status === 404)
      ) {
        throw unarchiveError;
      }
    }
    const recovered = await getRemoteAgent(
      input.client,
      input.manifest.agentId
    );
    if (!recovered) {
      throw new CliError(
        `Create agent failed (409): Agent ID ${input.manifest.agentId} already exists but is not readable with this API key. Use the owning organization key, unarchive the agent in Aleph, or assign a new agentId.`
      );
    }
    return {
      agent: await agentsApi.update(
        input.client,
        input.manifest.agentId,
        input.manifest
      ),
      created: false,
    };
  }
};

const removeMissingAgents = async (input: {
  readonly apiUrl: string;
  readonly bundles: string[];
  readonly client: ApiClient;
  readonly dryRun: boolean;
  readonly output: Output;
  readonly state: AgentState;
  readonly stateRoot: string;
}): Promise<AgentState> => {
  const bundleKeys = new Set(
    input.bundles.map((bundle) => bundleStateKey(input.stateRoot, bundle))
  );
  let state = input.state;
  for (const [key, agentId] of Object.entries(
    state.targets[input.apiUrl] ?? {}
  )) {
    if (bundleKeys.has(key)) {
      continue;
    }
    input.output.progress(
      `${input.dryRun ? "Planning removal of" : "Removing"} ${key}`
    );
    if (input.dryRun) {
      continue;
    }
    try {
      await agentsApi.archive(input.client, agentId);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) {
        throw error;
      }
      input.output.error(
        `Agent for removed bundle ${key} was already absent from Aleph; continuing.`
      );
    }
    state = removeStateAgentId(state, input.apiUrl, key);
    await saveState(input.stateRoot, state);
  }
  return state;
};

export const syncBundles = async (input: {
  readonly apiUrl: string;
  readonly bundles: string[];
  readonly client: ApiClient;
  readonly options: SyncOptions;
  readonly output: Output;
  readonly stateRoot: string;
}): Promise<SyncResult[]> => {
  const preparedBundles = await Promise.all(
    input.bundles.map(async (directory) => {
      const absolute = resolve(directory);
      const sourceManifest = await readAgentManifest(absolute);
      return {
        absolute,
        key: bundleStateKey(input.stateRoot, absolute),
        manifestHash: hashAgentManifest(sourceManifest),
        manifest: withResolvedIconUrl(
          sourceManifest,
          input.stateRoot,
          absolute
        ),
        sourceManifest,
      };
    })
  );
  const seenAgentIds = new Map<string, string>();
  for (const bundle of preparedBundles) {
    const duplicateDirectory = seenAgentIds.get(bundle.manifest.agentId);
    if (duplicateDirectory) {
      throw new CliError(
        `Duplicate agentId ${bundle.manifest.agentId} in ${duplicateDirectory} and ${bundle.key}`
      );
    }
    seenAgentIds.set(bundle.manifest.agentId, bundle.key);
  }

  let state = await loadState(input.stateRoot);
  state = await removeMissingAgents({
    apiUrl: input.apiUrl,
    bundles: input.bundles,
    client: input.client,
    dryRun: input.options.dryRun,
    output: input.output,
    state,
    stateRoot: input.stateRoot,
  });
  const limit = pLimit(input.options.concurrency);

  const syncOne = async (
    bundle: (typeof preparedBundles)[number]
  ): Promise<SyncResult> => {
    const { absolute, key, manifest, sourceManifest } = bundle;

    input.output.progress(
      `${input.options.dryRun ? "Planning" : "Syncing"} ${basename(absolute)}`
    );

    const existing = await getRemoteAgent(input.client, manifest.agentId);
    if (existing) {
      assertSyncVersionGate({
        agent: existing,
        directory: key,
        manifest: sourceManifest,
      });
    }

    if (input.options.dryRun) {
      if (isArchivedAgent(existing)) {
        input.output.progress(
          `Planning unarchive of archived agent ${manifest.agentId}`
        );
      }
      await collectBundleFiles(absolute, manifest.icon);
      return {
        agentId: manifest.agentId,
        directory: key,
        status: "planned",
      };
    }

    const { agent, created } = await updateOrCreateAgent({
      client: input.client,
      existing,
      manifest,
      name: basename(absolute),
      output: input.output,
    });
    state = setStateAgentId(state, input.apiUrl, key, agent.id);
    await saveState(input.stateRoot, state);

    const files = await collectBundleFiles(absolute, manifest.icon);
    if (files.length === 0) {
      throw new CliError(`Bundle ${key} has no uploadable files`);
    }
    const upload = await agentsApi.uploadVersion(
      input.client,
      agent.id,
      files,
      input.options.message ?? defaultMessage(),
      bundle.manifestHash
    );
    if (upload.created) {
      await applySyncLifecycle({
        agentId: agent.id,
        client: input.client,
        created,
        enable: input.options.enable,
        existingMode: existing?.mode,
        versionId: upload.version.id,
      });
    }
    await writeAgentManifest(absolute, {
      ...sourceManifest,
      versionId: upload.version.id,
    });
    let status: SyncResult["status"] = "unchanged";
    if (upload.created) {
      status = created ? "created" : "updated";
    }
    return {
      agentId: agent.id,
      directory: key,
      status,
      versionId: upload.version.id,
    };
  };

  const tasks = preparedBundles.map((bundle) =>
    limit(async (): Promise<SyncResult> => {
      try {
        return await syncOne(bundle);
      } catch (error) {
        if (!input.options.continueOnError) {
          throw error;
        }
        return {
          directory: bundle.key,
          error: error instanceof Error ? error.message : String(error),
          status: "failed",
        };
      }
    })
  );
  return Promise.all(tasks);
};
