import { basename, relative, resolve } from "node:path";

import pLimit from "p-limit";
import { z } from "zod";

import type { createApiClient } from "../api/client.js";
import { ApiError, CliError } from "../errors.js";
import type { Output } from "../output.js";
import { agentsApi } from "./agents-api.js";
import { collectBundleFiles } from "./files.js";
import type { AgentManifest } from "./manifest.js";
import { readAgentManifest } from "./manifest.js";
import {
  type AgentState,
  bundleStateKey,
  getStateAgentId,
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
  readonly status: "created" | "updated" | "planned" | "failed";
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

const updateOrCreateAgent = async (input: {
  readonly client: ApiClient;
  readonly existingId: string | undefined;
  readonly manifest: AgentManifest;
  readonly name: string;
  readonly output: Output;
}): Promise<{
  readonly agent: Awaited<ReturnType<typeof agentsApi.create>>;
  readonly created: boolean;
}> => {
  if (!input.existingId) {
    return {
      agent: await agentsApi.create(input.client, input.manifest),
      created: true,
    };
  }
  try {
    return {
      agent: await agentsApi.update(
        input.client,
        input.existingId,
        input.manifest
      ),
      created: false,
    };
  } catch (error) {
    if (!(error instanceof ApiError && error.status === 404)) {
      throw error;
    }
    input.output.progress(
      `Saved ID for ${input.name} no longer exists; creating it again`
    );
    return {
      agent: await agentsApi.create(input.client, input.manifest),
      created: true,
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

  const syncOne = async (directory: string): Promise<SyncResult> => {
    const absolute = resolve(directory);
    const manifest = withResolvedIconUrl(
      await readAgentManifest(absolute),
      input.stateRoot,
      absolute
    );
    const key = bundleStateKey(input.stateRoot, absolute);
    const existingId =
      manifest.agentId ?? getStateAgentId(state, input.apiUrl, key);

    input.output.progress(
      `${input.options.dryRun ? "Planning" : "Syncing"} ${basename(absolute)}`
    );
    if (input.options.dryRun) {
      await collectBundleFiles(absolute, manifest.icon);
      return {
        ...(existingId ? { agentId: existingId } : {}),
        directory: key,
        status: "planned",
      };
    }

    const { agent, created } = await updateOrCreateAgent({
      client: input.client,
      existingId,
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
    const version = await agentsApi.uploadVersion(
      input.client,
      agent.id,
      files,
      input.options.message ?? defaultMessage()
    );
    if (input.options.enable) {
      await agentsApi.enable(input.client, agent.id, version.id);
    } else {
      await agentsApi.disable(input.client, agent.id);
    }
    return {
      agentId: agent.id,
      directory: key,
      status: created ? "created" : "updated",
      versionId: version.id,
    };
  };

  const tasks = input.bundles.map((directory) =>
    limit(async (): Promise<SyncResult> => {
      try {
        return await syncOne(directory);
      } catch (error) {
        if (!input.options.continueOnError) {
          throw error;
        }
        return {
          directory: bundleStateKey(input.stateRoot, directory),
          error: error instanceof Error ? error.message : String(error),
          status: "failed",
        };
      }
    })
  );
  return Promise.all(tasks);
};
