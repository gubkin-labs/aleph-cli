import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";

import { z } from "zod";
import { CliError } from "../errors.js";

const PATH_SEPARATOR_PATTERN = /[\\/]/u;

const categories = [
  "Marketing",
  "Production",
  "FinOps",
  "Engineering",
  "Sales",
  "Research",
  "Lifestyle",
  "Productivity",
  "Trading",
] as const;

export const agentManifestSchema = z
  .object({
    agentId: z.uuid(),
    description: z.string().min(1),
    icon: z.string().min(1).optional(),
    iconUrl: z.string().url().optional(),
    labels: z.array(z.enum(categories)).max(3).default([]),
    name: z.string().min(1),
    versionId: z.uuid().optional(),
    visibility: z.enum(["private", "public"]).default("public"),
  })
  .superRefine((value, context) => {
    if (new Set(value.labels).size !== value.labels.length) {
      context.addIssue({
        code: "custom",
        message: "labels must be unique",
        path: ["labels"],
      });
    }
    if (
      value.icon &&
      (isAbsolute(value.icon) ||
        value.icon.split(PATH_SEPARATOR_PATTERN).includes(".."))
    ) {
      context.addIssue({
        code: "custom",
        message: "icon must be a safe relative path",
        path: ["icon"],
      });
    }
  });

export const repositoryManifestSchema = z.object({
  agents: z.array(z.string().min(1)).min(1),
});

export type AgentManifest = z.infer<typeof agentManifestSchema>;

export const hashAgentManifest = (manifest: AgentManifest): string => {
  const metadata = {
    description: manifest.description,
    icon: manifest.icon,
    iconUrl: manifest.iconUrl,
    labels: manifest.labels,
    name: manifest.name,
    visibility: manifest.visibility,
  };
  return createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
};

const isInside = (parent: string, child: string): boolean =>
  child === parent || child.startsWith(`${parent}${sep}`);

export const resolveSafeChild = (root: string, child: string): string => {
  const absoluteRoot = resolve(root);
  const absoluteChild = resolve(root, child);
  if (!isInside(absoluteRoot, absoluteChild)) {
    throw new Error(`Path escapes repository root: ${child}`);
  }
  return absoluteChild;
};

const serializeAgentManifest = (manifest: AgentManifest): string => {
  const payload: Record<string, unknown> = {
    agentId: manifest.agentId,
    name: manifest.name,
    description: manifest.description,
  };
  if (manifest.labels.length > 0) {
    payload.labels = manifest.labels;
  }
  if (manifest.icon !== undefined) {
    payload.icon = manifest.icon;
  }
  if (manifest.iconUrl !== undefined) {
    payload.iconUrl = manifest.iconUrl;
  }
  if (manifest.visibility !== "public") {
    payload.visibility = manifest.visibility;
  }
  if (manifest.versionId !== undefined) {
    payload.versionId = manifest.versionId;
  }
  return `${JSON.stringify(payload, null, 2)}\n`;
};

export const writeAgentManifest = async (
  directory: string,
  manifest: AgentManifest
): Promise<void> => {
  await writeFile(
    resolve(directory, "aleph.json"),
    serializeAgentManifest(manifest),
    "utf8"
  );
};

export const readAgentManifest = async (
  directory: string
): Promise<AgentManifest> => {
  const path = resolve(directory, "aleph.json");
  const text = await readFile(path, "utf8");
  const value: unknown = JSON.parse(text);
  if (
    !value ||
    typeof value !== "object" ||
    !("agentId" in value) ||
    typeof value.agentId !== "string" ||
    value.agentId.length === 0
  ) {
    throw new CliError(
      `Missing required agentId in ${path}. Add "agentId": "${randomUUID()}" to aleph.json.`
    );
  }
  if (
    value.agentId === "TEMPLATE" ||
    !z.uuid().safeParse(value.agentId).success
  ) {
    throw new CliError(
      `Invalid agentId "${value.agentId}" in ${path}. Run \`pnpm init-agents\` (or replace TEMPLATE with a permanent UUID) before syncing.`
    );
  }
  return agentManifestSchema.parse(value);
};
