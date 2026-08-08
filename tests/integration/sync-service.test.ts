import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { pullBundle, pullBundles } from "../../src/agents/pull-service.js";
import { syncBundles } from "../../src/agents/sync-service.js";
import { createApiClient } from "../../src/api/client.js";
import { CliError } from "../../src/errors.js";

const servers: ReturnType<typeof createServer>[] = [];
const directories: string[] = [];
const PIN_DRIFT_MESSAGE_PATTERN = /22222222-2222-4222-8222-222222222222/;
const PULL_GUIDANCE_PATTERN =
  /Do not edit versionId by hand\. Run `aleph agents pull .+` to download live files \+ stamp versionId, or `aleph agents pull .+ --stamp-version-id`/;
const AGENT_ID_FROM_URL_PATTERN = /\/agents\/([^/]+)/;

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

const startServer = async (
  handler: (request: IncomingMessage, response: ServerResponse) => void
): Promise<string> => {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Test server did not expose a TCP address");
  }
  return `http://127.0.0.1:${address.port}`;
};

const silentOutput = {
  data: () => undefined,
  error: () => undefined,
  json: false,
  progress: () => undefined,
};

const writeDemoBundle = async (
  root: string,
  extras: Record<string, unknown> = {}
): Promise<string> => {
  const bundle = join(root, "agents", "demo");
  await mkdir(bundle, { recursive: true });
  await writeFile(
    join(bundle, "aleph.json"),
    JSON.stringify({
      agentId: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
      description: "Demo agent",
      name: "Demo",
      ...extras,
    })
  );
  await writeFile(join(bundle, "AGENTS.md"), "# Demo\n");
  return bundle;
};

describe("syncBundles", () => {
  it("removes a saved ID after its deleted bundle is already absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-cli-sync-"));
    directories.push(root);
    await mkdir(join(root, ".aleph"));

    const requests: string[] = [];
    const apiUrl = await startServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "Not found" }));
    });
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
        ...silentOutput,
        error: (message) => errors.push(message),
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
    const bundle = await writeDemoBundle(root);
    await mkdir(join(root, ".aleph"));

    const requests: string[] = [];
    const apiUrl = await startServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") {
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
        ...silentOutput,
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
      "GET /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
      "POST /agents",
      "POST /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1/versions",
      "POST /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1/disable",
    ]);
    expect(progress).toContain(
      "Agent 45d8ec4c-a713-4d65-a76a-ef099ac57fb1 for demo does not exist; creating it with the manifest ID"
    );
    expect(
      JSON.parse(await readFile(join(bundle, "aleph.json"), "utf8")).versionId
    ).toBe("version-1");
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

  it("blocks sync when an existing agent has no local versionId", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-cli-sync-"));
    directories.push(root);
    const bundle = await writeDemoBundle(root);
    const apiUrl = await startServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.endsWith("/versions") && request.method === "GET") {
        response.end(
          JSON.stringify({
            data: [{ id: "version-existing" }],
            page: 1,
            pageSize: 100,
            total: 1,
          })
        );
        return;
      }
      response.end(
        JSON.stringify({
          id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
          mode: "disabled",
          name: "Demo",
          pinnedVersionId: null,
        })
      );
    });

    await expect(
      syncBundles({
        apiUrl,
        bundles: [bundle],
        client: createApiClient(apiUrl, {
          kind: "api-key",
          value: "test-key",
        }),
        options: {
          concurrency: 1,
          continueOnError: false,
          dryRun: true,
          enable: false,
        },
        output: silentOutput,
        stateRoot: root,
      })
    ).rejects.toThrow(PULL_GUIDANCE_PATTERN);
  });

  it("allows first sync when remote agent exists with no versions yet", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-cli-sync-"));
    directories.push(root);
    const bundle = await writeDemoBundle(root);
    const requests: string[] = [];
    const apiUrl = await startServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      if (request.url?.endsWith("/versions") && request.method === "GET") {
        response.end(
          JSON.stringify({
            data: [],
            page: 1,
            pageSize: 100,
            total: 0,
          })
        );
        return;
      }
      if (request.url?.endsWith("/versions") && request.method === "POST") {
        response.statusCode = 201;
        response.end(JSON.stringify({ id: "version-1" }));
        return;
      }
      if (request.url?.endsWith("/disable")) {
        response.end(
          JSON.stringify({
            id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
            mode: "disabled",
            name: "Demo",
          })
        );
        return;
      }
      if (request.method === "PATCH") {
        response.end(
          JSON.stringify({
            id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
            mode: "disabled",
            name: "Demo",
            pinnedVersionId: null,
          })
        );
        return;
      }
      response.end(
        JSON.stringify({
          id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
          mode: "disabled",
          name: "Demo",
          pinnedVersionId: null,
        })
      );
    });

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
      output: silentOutput,
      stateRoot: root,
    });

    expect(result).toEqual([
      {
        agentId: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
        directory: "agents/demo",
        status: "updated",
        versionId: "version-1",
      },
    ]);
    expect(requests).toContain(
      "GET /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1/versions"
    );
  });

  it("blocks sync when the enabled pin differs from versionId", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-cli-sync-"));
    directories.push(root);
    const bundle = await writeDemoBundle(root, {
      versionId: "11111111-1111-4111-8111-111111111111",
    });
    const apiUrl = await startServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
          mode: "enabled",
          name: "Demo",
          pinnedVersionId: "22222222-2222-4222-8222-222222222222",
        })
      );
    });

    const error = await syncBundles({
      apiUrl,
      bundles: [bundle],
      client: createApiClient(apiUrl, { kind: "api-key", value: "test-key" }),
      options: {
        concurrency: 1,
        continueOnError: false,
        dryRun: true,
        enable: true,
      },
      output: silentOutput,
      stateRoot: root,
    }).catch((value: unknown) => value);

    expect(error).toBeInstanceOf(CliError);
    expect(String(error)).toMatch(PIN_DRIFT_MESSAGE_PATTERN);
    expect(String(error)).toMatch(PULL_GUIDANCE_PATTERN);
  });

  it("allows sync and stamps versionId when pin matches", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-cli-sync-"));
    directories.push(root);
    const versionId = "11111111-1111-4111-8111-111111111111";
    const bundle = await writeDemoBundle(root, { versionId });
    const apiUrl = await startServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.endsWith("/versions") && request.method === "POST") {
        response.statusCode = 200;
        response.end(JSON.stringify({ id: versionId }));
        return;
      }
      if (request.method === "PATCH") {
        response.end(
          JSON.stringify({
            id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
            mode: "enabled",
            name: "Demo",
            pinnedVersionId: versionId,
          })
        );
        return;
      }
      response.end(
        JSON.stringify({
          id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
          mode: "enabled",
          name: "Demo",
          pinnedVersionId: versionId,
        })
      );
    });

    const result = await syncBundles({
      apiUrl,
      bundles: [bundle],
      client: createApiClient(apiUrl, { kind: "api-key", value: "test-key" }),
      options: {
        concurrency: 1,
        continueOnError: false,
        dryRun: false,
        enable: true,
      },
      output: silentOutput,
      stateRoot: root,
    });

    expect(result).toEqual([
      {
        agentId: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
        directory: "agents/demo",
        status: "unchanged",
        versionId,
      },
    ]);
    expect(
      JSON.parse(await readFile(join(bundle, "aleph.json"), "utf8")).versionId
    ).toBe(versionId);
  });

  it("unarchives an existing archived agent before updating", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-cli-sync-"));
    directories.push(root);
    const versionId = "11111111-1111-4111-8111-111111111111";
    const nextVersionId = "66666666-6666-4666-8666-666666666666";
    const bundle = await writeDemoBundle(root, { versionId });
    const requests: string[] = [];
    const progress: string[] = [];
    const apiUrl = await startServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      if (request.url?.endsWith("/unarchive") && request.method === "POST") {
        response.end(
          JSON.stringify({
            archivedAt: null,
            id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
            mode: "disabled",
            name: "Demo",
            pinnedVersionId: null,
          })
        );
        return;
      }
      if (request.url?.endsWith("/versions") && request.method === "POST") {
        response.statusCode = 201;
        response.end(JSON.stringify({ id: nextVersionId }));
        return;
      }
      if (request.method === "PATCH") {
        response.end(
          JSON.stringify({
            archivedAt: null,
            id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
            mode: "disabled",
            name: "Demo",
            pinnedVersionId: null,
          })
        );
        return;
      }
      response.end(
        JSON.stringify({
          archivedAt: "2026-08-08T04:42:47.240Z",
          id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
          mode: "disabled",
          name: "Demo",
          pinnedVersionId: null,
        })
      );
    });

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
        ...silentOutput,
        progress: (message) => progress.push(message),
      },
      stateRoot: root,
    });

    expect(result).toEqual([
      {
        agentId: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
        directory: "agents/demo",
        status: "updated",
        versionId: nextVersionId,
      },
    ]);
    expect(requests).toEqual([
      "GET /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
      "POST /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1/unarchive",
      "PATCH /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
      "POST /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1/versions",
    ]);
    expect(progress).toContain(
      "Agent 45d8ec4c-a713-4d65-a76a-ef099ac57fb1 for demo is archived; unarchiving it"
    );
  });

  it("recovers create 409 by unarchiving and updating the existing agent", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-cli-sync-"));
    directories.push(root);
    const bundle = await writeDemoBundle(root);
    const requests: string[] = [];
    let getCount = 0;
    const apiUrl = await startServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") {
        getCount += 1;
        if (getCount === 1) {
          response.statusCode = 404;
          response.end(JSON.stringify({ message: "Not found" }));
          return;
        }
        response.end(
          JSON.stringify({
            archivedAt: null,
            id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
            mode: "disabled",
            name: "Demo",
            pinnedVersionId: null,
          })
        );
        return;
      }
      if (request.method === "POST" && request.url === "/agents") {
        response.statusCode = 409;
        response.end(JSON.stringify({ message: "Agent ID already exists" }));
        return;
      }
      if (request.url?.endsWith("/unarchive")) {
        response.end(
          JSON.stringify({
            archivedAt: null,
            id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
            mode: "disabled",
            name: "Demo",
          })
        );
        return;
      }
      if (request.url?.endsWith("/versions")) {
        response.statusCode = 201;
        response.end(JSON.stringify({ id: "version-1" }));
        return;
      }
      if (request.url?.endsWith("/disable")) {
        response.end(
          JSON.stringify({
            id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
            mode: "disabled",
            name: "Demo",
          })
        );
        return;
      }
      response.end(
        JSON.stringify({
          id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
          mode: "disabled",
          name: "Demo",
        })
      );
    });

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
      output: silentOutput,
      stateRoot: root,
    });

    expect(result).toEqual([
      {
        agentId: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
        directory: "agents/demo",
        status: "updated",
        versionId: "version-1",
      },
    ]);
    expect(requests).toEqual([
      "GET /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
      "POST /agents",
      "POST /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1/unarchive",
      "GET /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
      "PATCH /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
      "POST /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1/versions",
    ]);
  });

  it("does not disable an existing agent when syncing with --no-enable", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-cli-sync-"));
    directories.push(root);
    const versionId = "11111111-1111-4111-8111-111111111111";
    const nextVersionId = "44444444-4444-4444-8444-444444444444";
    const bundle = await writeDemoBundle(root, { versionId });
    const requests: string[] = [];
    const apiUrl = await startServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      if (request.url?.endsWith("/versions") && request.method === "POST") {
        response.statusCode = 201;
        response.end(JSON.stringify({ id: nextVersionId }));
        return;
      }
      if (request.method === "PATCH") {
        response.end(
          JSON.stringify({
            id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
            mode: "disabled",
            name: "Demo",
            pinnedVersionId: null,
          })
        );
        return;
      }
      response.end(
        JSON.stringify({
          id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
          mode: "disabled",
          name: "Demo",
          pinnedVersionId: null,
        })
      );
    });

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
      output: silentOutput,
      stateRoot: root,
    });

    expect(result).toEqual([
      {
        agentId: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
        directory: "agents/demo",
        status: "updated",
        versionId: nextVersionId,
      },
    ]);
    expect(requests).toEqual([
      "GET /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
      "PATCH /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
      "POST /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1/versions",
    ]);
    expect(requests.some((entry) => entry.includes("/disable"))).toBe(false);
    expect(requests.some((entry) => entry.includes("/enable"))).toBe(false);
  });

  it("repins an already-enabled agent when syncing with --no-enable", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-cli-sync-"));
    directories.push(root);
    const versionId = "11111111-1111-4111-8111-111111111111";
    const nextVersionId = "55555555-5555-4555-8555-555555555555";
    const bundle = await writeDemoBundle(root, { versionId });
    const requests: string[] = [];
    const apiUrl = await startServer((request, response) => {
      requests.push(`${request.method} ${request.url}`);
      response.setHeader("content-type", "application/json");
      if (request.url?.endsWith("/versions") && request.method === "POST") {
        response.statusCode = 201;
        response.end(JSON.stringify({ id: nextVersionId }));
        return;
      }
      if (request.url?.endsWith("/enable")) {
        response.end(
          JSON.stringify({
            id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
            mode: "enabled",
            name: "Demo",
            pinnedVersionId: nextVersionId,
          })
        );
        return;
      }
      if (request.method === "PATCH") {
        response.end(
          JSON.stringify({
            id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
            mode: "enabled",
            name: "Demo",
            pinnedVersionId: versionId,
          })
        );
        return;
      }
      response.end(
        JSON.stringify({
          id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
          mode: "enabled",
          name: "Demo",
          pinnedVersionId: versionId,
        })
      );
    });

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
      output: silentOutput,
      stateRoot: root,
    });

    expect(result).toEqual([
      {
        agentId: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
        directory: "agents/demo",
        status: "updated",
        versionId: nextVersionId,
      },
    ]);
    expect(requests).toContain(
      "POST /agents/45d8ec4c-a713-4d65-a76a-ef099ac57fb1/enable"
    );
    expect(requests.some((entry) => entry.includes("/disable"))).toBe(false);
  });
});

describe("pullBundle", () => {
  it("writes version files and stamps versionId", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-cli-pull-"));
    directories.push(root);
    const bundle = await writeDemoBundle(root);
    await writeFile(join(bundle, "local-extra.md"), "keep me\n");
    const versionId = "33333333-3333-4333-8333-333333333333";
    const boundary = "test-boundary";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="AGENTS.md"',
      "Content-Type: text/markdown",
      "",
      "# Pulled",
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="README.md"',
      "Content-Type: text/markdown",
      "",
      "# Readme",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const apiUrl = await startServer((request, response) => {
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
          id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
          mode: "enabled",
          name: "Demo",
          pinnedVersionId: versionId,
        })
      );
    });

    const result = await pullBundle({
      client: createApiClient(apiUrl, { kind: "api-key", value: "test-key" }),
      directory: bundle,
      output: silentOutput,
    });

    expect(result).toEqual({
      agentId: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
      directory: bundle,
      fileCount: 2,
      status: "pulled",
      versionId,
    });
    expect(await readFile(join(bundle, "AGENTS.md"), "utf8")).toBe("# Pulled");
    expect(await readFile(join(bundle, "README.md"), "utf8")).toBe("# Readme");
    expect(await readFile(join(bundle, "local-extra.md"), "utf8")).toBe(
      "keep me\n"
    );
    expect(
      JSON.parse(await readFile(join(bundle, "aleph.json"), "utf8")).versionId
    ).toBe(versionId);
  });

  it("stamps versionId without overwriting local files", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-cli-stamp-"));
    directories.push(root);
    const bundle = await writeDemoBundle(root, {
      versionId: "11111111-1111-4111-8111-111111111111",
    });
    await writeFile(join(bundle, "AGENTS.md"), "# Local edits\n");
    const versionId = "33333333-3333-4333-8333-333333333333";
    let filesRequested = false;

    const apiUrl = await startServer((request, response) => {
      if (request.url?.endsWith("/files")) {
        filesRequested = true;
        response.statusCode = 500;
        response.end("should not download");
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
          mode: "enabled",
          name: "Demo",
          pinnedVersionId: versionId,
        })
      );
    });

    const result = await pullBundle({
      client: createApiClient(apiUrl, { kind: "api-key", value: "test-key" }),
      directory: bundle,
      output: silentOutput,
      stampVersionId: true,
    });

    expect(result).toEqual({
      agentId: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
      directory: bundle,
      fileCount: 0,
      status: "stamped",
      versionId,
    });
    expect(filesRequested).toBe(false);
    expect(await readFile(join(bundle, "AGENTS.md"), "utf8")).toBe(
      "# Local edits\n"
    );
    expect(
      JSON.parse(await readFile(join(bundle, "aleph.json"), "utf8")).versionId
    ).toBe(versionId);
  });

  it("pulls every discovered agent under a repository root", async () => {
    const root = await mkdtemp(join(tmpdir(), "aleph-cli-pull-all-"));
    directories.push(root);
    const first = await writeDemoBundle(root);
    const second = join(root, "agents", "other");
    await mkdir(second, { recursive: true });
    await writeFile(
      join(second, "aleph.json"),
      JSON.stringify({
        agentId: "56d8ec4c-a713-4d65-a76a-ef099ac57fb2",
        description: "Other agent",
        name: "Other",
      })
    );
    await writeFile(join(second, "AGENTS.md"), "# Other\n");

    const versionByAgent: Record<string, string> = {
      "45d8ec4c-a713-4d65-a76a-ef099ac57fb1":
        "33333333-3333-4333-8333-333333333333",
      "56d8ec4c-a713-4d65-a76a-ef099ac57fb2":
        "44444444-4444-4444-8444-444444444444",
    };
    const boundary = "bulk-boundary";
    const body = [
      `--${boundary}`,
      'Content-Disposition: form-data; name="files"; filename="AGENTS.md"',
      "Content-Type: text/markdown",
      "",
      "# Pulled bulk",
      `--${boundary}--`,
      "",
    ].join("\r\n");

    const apiUrl = await startServer((request, response) => {
      if (request.url?.endsWith("/files")) {
        response.statusCode = 200;
        response.setHeader(
          "content-type",
          `multipart/form-data; boundary=${boundary}`
        );
        response.end(body);
        return;
      }
      const agentId = request.url?.match(AGENT_ID_FROM_URL_PATTERN)?.[1];
      if (!(agentId && agentId in versionByAgent)) {
        response.statusCode = 404;
        response.end(JSON.stringify({ message: "Not found" }));
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          id: agentId,
          mode: "enabled",
          name: "Demo",
          pinnedVersionId: versionByAgent[agentId],
        })
      );
    });

    const results = await pullBundles({
      client: createApiClient(apiUrl, { kind: "api-key", value: "test-key" }),
      directory: root,
      output: silentOutput,
    });

    expect(results).toEqual([
      {
        agentId: "45d8ec4c-a713-4d65-a76a-ef099ac57fb1",
        directory: "agents/demo",
        fileCount: 1,
        status: "pulled",
        versionId: "33333333-3333-4333-8333-333333333333",
      },
      {
        agentId: "56d8ec4c-a713-4d65-a76a-ef099ac57fb2",
        directory: "agents/other",
        fileCount: 1,
        status: "pulled",
        versionId: "44444444-4444-4444-8444-444444444444",
      },
    ]);
    expect(
      JSON.parse(await readFile(join(first, "aleph.json"), "utf8")).versionId
    ).toBe("33333333-3333-4333-8333-333333333333");
    expect(
      JSON.parse(await readFile(join(second, "aleph.json"), "utf8")).versionId
    ).toBe("44444444-4444-4444-8444-444444444444");
  });
});
