import { z } from "zod";

import type { createApiClient } from "../api/client.js";
import { throwApiError } from "../api/response.js";
import type { BundleFile } from "./files.js";
import type { AgentManifest } from "./manifest.js";

type ApiClient = ReturnType<typeof createApiClient>;

const agentSchema = z
  .object({
    id: z.string(),
    mode: z.string().optional(),
    name: z.string(),
    pinnedVersionId: z.string().nullable().optional(),
  })
  .passthrough();

const agentVersionSchema = z
  .object({
    id: z.string(),
  })
  .passthrough();

const agentsPageSchema = z.object({
  data: z.array(agentSchema),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

const metadataBody = (manifest: AgentManifest): Record<string, unknown> => ({
  description: manifest.description,
  iconUrl: manifest.iconUrl ?? null,
  labels: manifest.labels,
  name: manifest.name,
  visibility: manifest.visibility,
});

export const agentsApi = {
  async archive(
    client: ApiClient,
    agentId: string
  ): Promise<z.infer<typeof agentSchema>> {
    const result = await client.POST("/agents/:agentId/archive", {
      params: { path: { agentId } },
    });
    if (!result.data) {
      throwApiError(result.response, result.error, "Archive agent");
    }
    return agentSchema.parse(result.data);
  },

  async create(
    client: ApiClient,
    manifest: AgentManifest
  ): Promise<z.infer<typeof agentSchema>> {
    const result = await client.POST("/agents", {
      body: { ...metadataBody(manifest), agentId: manifest.agentId },
    });
    if (!result.data) {
      throwApiError(result.response, result.error, "Create agent");
    }
    const agent = agentSchema.parse(result.data);
    if (agent.id !== manifest.agentId) {
      throw new Error(
        `Create agent returned ID ${agent.id}; expected ${manifest.agentId}`
      );
    }
    return agent;
  },

  async disable(
    client: ApiClient,
    agentId: string
  ): Promise<z.infer<typeof agentSchema>> {
    const result = await client.POST("/agents/:agentId/disable", {
      params: { path: { agentId } },
    });
    if (!result.data) {
      throwApiError(result.response, result.error, "Disable agent");
    }
    return agentSchema.parse(result.data);
  },

  async enable(
    client: ApiClient,
    agentId: string,
    versionId?: string
  ): Promise<z.infer<typeof agentSchema>> {
    const result = await client.POST("/agents/:agentId/enable", {
      body: versionId ? { versionId } : {},
      params: { path: { agentId } },
    });
    if (!result.data) {
      throwApiError(result.response, result.error, "Enable agent");
    }
    return agentSchema.parse(result.data);
  },

  async list(client: ApiClient): Promise<z.infer<typeof agentsPageSchema>> {
    const result = await client.GET("/agents", {
      params: { query: { page: 1, pageSize: 100 } },
    });
    if (!result.data) {
      throwApiError(result.response, result.error, "List agents");
    }
    return agentsPageSchema.parse(result.data);
  },

  async update(
    client: ApiClient,
    agentId: string,
    manifest: AgentManifest
  ): Promise<z.infer<typeof agentSchema>> {
    const result = await client.PATCH("/agents/:agentId", {
      body: metadataBody(manifest),
      params: { path: { agentId } },
    });
    if (!result.data) {
      throwApiError(result.response, result.error, "Update agent");
    }
    return agentSchema.parse(result.data);
  },

  async uploadVersion(
    client: ApiClient,
    agentId: string,
    files: BundleFile[],
    message: string
  ): Promise<{
    created: boolean;
    version: z.infer<typeof agentVersionSchema>;
  }> {
    const form = new FormData();
    form.append("message", message);
    for (const file of files) {
      form.append("files", new Blob([file.bytes]), file.path);
    }
    const result = await client.POST("/agents/:agentId/versions", {
      body: form,
      bodySerializer: (body) => body as BodyInit,
      params: { path: { agentId } },
    });
    if (!result.data) {
      throwApiError(result.response, result.error, "Upload agent version");
    }
    return {
      created: result.response.status === 201,
      version: agentVersionSchema.parse(result.data),
    };
  },
};
