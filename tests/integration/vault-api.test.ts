import { createServer } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createApiClient } from "../../src/api/client.js";
import { vaultApi } from "../../src/vault/vault-api.js";

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

describe("vault API client", () => {
  it("creates a missing personal vault value without returning its value", async () => {
    const requests: Array<{
      body: string;
      method: string | undefined;
      url: string | undefined;
    }> = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      request.on("end", () => {
        requests.push({ body, method: request.method, url: request.url });
        response.setHeader("content-type", "application/json");
        if (request.method === "PATCH") {
          response.statusCode = 404;
          response.end(JSON.stringify({ message: "Not found" }));
          return;
        }
        response.statusCode = 201;
        response.end(
          JSON.stringify({
            description: "Repository token",
            name: "GH_TOKEN",
            scopeType: "user",
          })
        );
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not expose a TCP address");
    }

    const entry = await vaultApi.set(
      createApiClient(`http://127.0.0.1:${address.port}`, {
        kind: "api-key",
        value: "test-key",
      }),
      { kind: "user" },
      {
        description: "Repository token",
        name: "GH_TOKEN",
        value: "super-secret",
      }
    );

    expect(entry).toMatchObject({ name: "GH_TOKEN", scopeType: "user" });
    expect(requests).toEqual([
      {
        body: JSON.stringify({
          description: "Repository token",
          value: "super-secret",
        }),
        method: "PATCH",
        url: "/me/vault/GH_TOKEN",
      },
      {
        body: JSON.stringify({
          description: "Repository token",
          name: "GH_TOKEN",
          value: "super-secret",
        }),
        method: "POST",
        url: "/me/vault",
      },
    ]);
  });
});
