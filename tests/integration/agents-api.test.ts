import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";
import { agentsApi } from "../../src/agents/agents-api.js";
import { createApiClient } from "../../src/api/client.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    )
  );
});

describe("agents API client", () => {
  it("uses API-key auth and pins the uploaded version", async () => {
    const requests: Array<{
      authorization: string | undefined;
      method: string | undefined;
      url: string | undefined;
    }> = [];
    const server = createServer((request, response) => {
      requests.push({
        authorization: request.headers["x-api-key"] as string | undefined,
        method: request.method,
        url: request.url,
      });
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify(
          request.url?.endsWith("/versions")
            ? { id: "version-1" }
            : { id: "agent-1", name: "Agent" }
        )
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not expose a TCP address");
    }
    const client = createApiClient(`http://127.0.0.1:${address.port}`, {
      kind: "api-key",
      value: "test-key",
    });

    const upload = await agentsApi.uploadVersion(
      client,
      "agent-1",
      [{ bytes: new TextEncoder().encode("# Agent"), path: "AGENTS.md" }],
      "test sync",
      "a".repeat(64)
    );
    await agentsApi.enable(client, "agent-1", upload.version.id);
    expect(upload.created).toBe(false);

    expect(requests).toEqual([
      {
        authorization: "test-key",
        method: "POST",
        url: "/agents/agent-1/versions",
      },
      {
        authorization: "test-key",
        method: "POST",
        url: "/agents/agent-1/enable",
      },
    ]);
  });
});
