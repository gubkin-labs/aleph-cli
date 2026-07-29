import { z } from "zod";

import type { createApiClient } from "../api/client.js";
import { throwApiError } from "../api/response.js";

type ApiClient = ReturnType<typeof createApiClient>;

export type VaultScope =
  | { readonly kind: "user" }
  | { readonly id: string; readonly kind: "org" }
  | { readonly id: string; readonly kind: "team" };

export interface VaultSetInput {
  readonly description?: string | undefined;
  readonly name: string;
  readonly value: string;
}

const vaultEntrySchema = z
  .object({
    description: z.string().nullable().optional(),
    name: z.string(),
    scopeId: z.string().optional(),
    scopeType: z.enum(["org", "team", "user"]).optional(),
  })
  .passthrough();

const updateUserEntry = async (client: ApiClient, input: VaultSetInput) =>
  client.PATCH("/me/vault/{name}", {
    body: { description: input.description, value: input.value },
    params: { path: { name: input.name } },
  });

const createUserEntry = async (client: ApiClient, input: VaultSetInput) =>
  client.POST("/me/vault", { body: { ...input } });

const updateOrgEntry = async (
  client: ApiClient,
  organizationId: string,
  input: VaultSetInput
) =>
  client.PATCH("/orgs/{organizationId}/vault/{name}", {
    body: { description: input.description, value: input.value },
    params: { path: { name: input.name, organizationId } },
  });

const createOrgEntry = async (
  client: ApiClient,
  organizationId: string,
  input: VaultSetInput
) =>
  client.POST("/orgs/{organizationId}/vault", {
    body: { ...input },
    params: { path: { organizationId } },
  });

const updateTeamEntry = async (
  client: ApiClient,
  teamId: string,
  input: VaultSetInput
) =>
  client.PATCH("/teams/{teamId}/vault/{name}", {
    body: { description: input.description, value: input.value },
    params: { path: { name: input.name, teamId } },
  });

const createTeamEntry = async (
  client: ApiClient,
  teamId: string,
  input: VaultSetInput
) =>
  client.POST("/teams/{teamId}/vault", {
    body: { ...input },
    params: { path: { teamId } },
  });

type VaultUpdateResponse =
  | Awaited<ReturnType<typeof updateUserEntry>>
  | Awaited<ReturnType<typeof updateOrgEntry>>
  | Awaited<ReturnType<typeof updateTeamEntry>>;

type VaultCreateResponse =
  | Awaited<ReturnType<typeof createUserEntry>>
  | Awaited<ReturnType<typeof createOrgEntry>>
  | Awaited<ReturnType<typeof createTeamEntry>>;

export const vaultApi = {
  async set(
    client: ApiClient,
    scope: VaultScope,
    input: VaultSetInput
  ): Promise<z.infer<typeof vaultEntrySchema>> {
    let response: VaultUpdateResponse;
    if (scope.kind === "user") {
      response = await updateUserEntry(client, input);
    } else if (scope.kind === "org") {
      response = await updateOrgEntry(client, scope.id, input);
    } else {
      response = await updateTeamEntry(client, scope.id, input);
    }

    if (response.data) {
      return vaultEntrySchema.parse(response.data);
    }
    if (response.response.status !== 404) {
      throwApiError(response.response, response.error, "Update vault entry");
    }

    let created: VaultCreateResponse;
    if (scope.kind === "user") {
      created = await createUserEntry(client, input);
    } else if (scope.kind === "org") {
      created = await createOrgEntry(client, scope.id, input);
    } else {
      created = await createTeamEntry(client, scope.id, input);
    }
    if (!created.data) {
      throwApiError(created.response, created.error, "Create vault entry");
    }
    return vaultEntrySchema.parse(created.data);
  },
};
