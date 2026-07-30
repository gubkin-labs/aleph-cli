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

const versionsPageSchema = z.object({
  data: z.array(agentVersionSchema),
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

  async downloadVersionFiles(
    client: ApiClient,
    agentId: string,
    versionId: string
  ): Promise<BundleFile[]> {
    const result = await client.GET(
      "/agents/:agentId/versions/:versionId/files",
      {
        params: { path: { agentId, versionId } },
        parseAs: "arrayBuffer",
      }
    );
    if (!result.response.ok) {
      throwApiError(result.response, result.error, "Download version files");
    }
    const contentType = result.response.headers.get("content-type");
    if (!(result.data instanceof ArrayBuffer && contentType)) {
      throw new Error(
        "Download version files returned an empty multipart body"
      );
    }
    const formData = await new Response(result.data, {
      headers: { "content-type": contentType },
    }).formData();
    const files: BundleFile[] = [];
    for (const entry of formData.getAll("files")) {
      if (!(entry instanceof File)) {
        continue;
      }
      files.push({
        bytes: new Uint8Array(await entry.arrayBuffer()),
        path: entry.name,
      });
    }
    return files.sort((left, right) => left.path.localeCompare(right.path));
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

  async get(
    client: ApiClient,
    agentId: string
  ): Promise<z.infer<typeof agentSchema>> {
    const result = await client.GET("/agents/:agentId", {
      params: { path: { agentId } },
    });
    if (!result.data) {
      throwApiError(result.response, result.error, "Get agent");
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

  async listVersions(
    client: ApiClient,
    agentId: string
  ): Promise<z.infer<typeof versionsPageSchema>> {
    const result = await client.GET("/agents/:agentId/versions", {
      params: { path: { agentId } },
    });
    if (!result.data) {
      throwApiError(result.response, result.error, "List agent versions");
    }
    return versionsPageSchema.parse(result.data);
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
    message: string,
    manifestHash: string
  ): Promise<{
    created: boolean;
    version: z.infer<typeof agentVersionSchema>;
  }> {
    const form = new FormData();
    form.append("message", message);
    form.append("manifestHash", manifestHash);
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
