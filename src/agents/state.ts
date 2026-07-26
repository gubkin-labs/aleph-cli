import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { z } from "zod";

const stateSchema = z.object({
  schemaVersion: z.literal(1),
  targets: z.record(z.string(), z.record(z.string(), z.string())),
});

export type AgentState = z.infer<typeof stateSchema>;

export const emptyState = (): AgentState => ({
  schemaVersion: 1,
  targets: {},
});

export const statePath = (root: string): string =>
  join(root, ".aleph", "state.json");

export const loadState = async (root: string): Promise<AgentState> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(statePath(root), "utf8"));
    return stateSchema.parse(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return emptyState();
    }
    throw error;
  }
};

export const bundleStateKey = (root: string, bundle: string): string =>
  relative(resolve(root), resolve(bundle)).split("\\").join("/");

export const getStateAgentId = (
  state: AgentState,
  apiUrl: string,
  key: string
): string | undefined => state.targets[apiUrl]?.[key];

export const setStateAgentId = (
  state: AgentState,
  apiUrl: string,
  key: string,
  agentId: string
): AgentState => ({
  ...state,
  targets: {
    ...state.targets,
    [apiUrl]: {
      ...state.targets[apiUrl],
      [key]: agentId,
    },
  },
});

export const saveState = async (
  root: string,
  state: AgentState
): Promise<void> => {
  const path = statePath(root);
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, path);
};
