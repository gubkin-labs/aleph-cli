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

  it("gets an agent and downloads multipart version files", async () => {
    const boundary = "download-boundary";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="AGENTS.md"',
      "Content-Type: text/markdown",
      "",
      "# Agent",
      `--${boundary}--`,
      "",
    ].join("\r\n");
    const server = createServer((request, response) => {
      if (request.url?.endsWith("/files")) {
        response.statusCode = 200;
        response.setHeader(
          "content-type",
          `multipart/form-data; boundary=${boundary}`
        );
        response.end(body);
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "agent-1",
          mode: "enabled",
          name: "Agent",
          pinnedVersionId: "version-1",
        })
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

    const agent = await agentsApi.get(client, "agent-1");
    const files = await agentsApi.downloadVersionFiles(
      client,
      "agent-1",
      "version-1"
    );

    expect(agent.pinnedVersionId).toBe("version-1");
    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("AGENTS.md");
    expect(new TextDecoder().decode(files[0]?.bytes)).toBe("# Agent");
  });
});
