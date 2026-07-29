import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { syncBundles } from "../../src/agents/sync-service.js";
import { createApiClient } from "../../src/api/client.js";

const servers: ReturnType<typeof createServer>[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all([
    ...servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        })
    ),
    ...directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  ]);
});

describe("syncBundles", () => {
  it("removes a saved ID after its deleted bundle is already absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-cli-sync-"));
    directories.push(root);
    await mkdir(join(root, ".aleph"));

    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "Not found" }));
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve)
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not expose a TCP address");
    }
    const apiUrl = `http://127.0.0.1:${address.port}`;
    await writeFile(
      join(root, ".aleph", "state.json"),
      JSON.stringify({
        schemaVersion: 1,
        targets: { [apiUrl]: { "agents/removed": "removed-agent" } },
      })
    );
    const errors: string[] = [];

    const result = await syncBundles({
      apiUrl,
      bundles: [],
      client: createApiClient(apiUrl, { kind: "api-key", value: "test-key" }),
      options: {
        concurrency: 1,
        continueOnError: false,
        dryRun: false,
        enable: false,
      },
      output: {
        data: () => undefined,
        error: (message) => errors.push(message),
        json: false,
        progress: () => undefined,
      },
      stateRoot: root,
    });

    expect(result).toEqual([]);
    expect(requests).toEqual(["POST /agents/removed-agent/archive"]);
    expect(errors).toEqual([
      "Agent for removed bundle agents/removed was already absent from Aleph; continuing.",
    ]);
    expect(
      JSON.parse(await readFile(join(root, ".aleph", "state.json"), "utf8"))
    ).toEqual({ schemaVersion: 1, targets: {} });
  });

  it("recreates an agent when its saved ID is no longer available", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-cli-sync-"));
    directories.push(root);
    const bundle = join(root, "agents", "demo");
    await mkdir(bundle, { recursive: true });
    await writeFile(
      join(bundle, "aleph.json"),
      JSON.stringify({
        agentId: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
        description: "Demo agent",
        name: "Demo",
      })
    );
    await writeFile(join(bundle, "AGENTS.md"), "# Demo\n");
    await mkdir(join(root, ".aleph"));
    await writeFile(
      join(root, ".aleph", "state.json"),
      JSON.stringify({
        schemaVersion: 1,
        targets: { "http://placeholder": { "agents/demo": "stale-agent" } },
      })
    );

    const requests: string[] = [];
    const server = createServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      if (request.method === "PATCH") {
        response.statusCode = 404;
        response.end(JSON.stringify({ message: "Not found" }));
        return;
      }
      if (request.url?.endsWith("/versions")) {
        response.statusCode = 201;
        response.end(JSON.stringify({ id: "version-1" }));
        return;
      }
      response.end(
        JSON.stringify({
          id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
          name: "Demo",
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
    const apiUrl = `http://127.0.0.1:${address.port}`;
    await writeFile(
      join(root, ".aleph", "state.json"),
      JSON.stringify({
        schemaVersion: 1,
        targets: { [apiUrl]: { "agents/demo": "stale-agent" } },
      })
    );
    const progress: string[] = [];

    const result = await syncBundles({
      apiUrl,
      bundles: [bundle],
      client: createApiClient(apiUrl, { kind: "api-key", value: "test-key" }),
      options: {
        concurrency: 1,
        continueOnError: false,
        dryRun: false,
        enable: false,
      },
      output: {
        data: () => undefined,
        error: () => undefined,
        json: false,
        progress: (message) => progress.push(message),
      },
      stateRoot: root,
    });

    expect(result).toEqual([
      {
        agentId: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
        directory: "agents/demo",
        status: "created",
        versionId: "version-1",
      },
    ]);
    expect(requests).toEqual([
      "PATCH /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
      "POST /agents",
      "POST /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1/versions",
      "POST /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1/disable",
    ]);
    expect(progress).toContain(
      "Agent 45d8ec4c-a713-4d65-a76a-ef099ac57fb1 for demo does not exist; creating it with the manifest ID"
    );
    const state = JSON.parse(
      await readFile(join(root, ".aleph", "state.json"), "utf8")
    );
    expect(state).toEqual({
      schemaVersion: 1,
      targets: {
        [apiUrl]: {
          "agents/demo": "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
        },
      },
    });
  });
});
