import { resolve } from "node:path";

import { Command } from "commander";
import { z } from "zod";
import { agentsApi } from "./agents/agents-api.js";
import { discoverBundles } from "./agents/discover.js";
import { readAgentManifest } from "./agents/manifest.js";
import { pullBundle } from "./agents/pull-service.js";
import { syncBundles, syncOptionsSchema } from "./agents/sync-service.js";
import { createApiClient } from "./api/client.js";
import { login } from "./auth/auth-service.js";
import { credentialStore } from "./auth/credential-store.js";
import { resolveCredential } from "./auth/resolve-credential.js";
import {
  type GlobalOptions,
  globalOptionsSchema,
  resolveApiUrl,
} from "./config.js";
import { CliError } from "./errors.js";
import { createOutput } from "./output.js";
import { type VaultScope, vaultApi } from "./vault/vault-api.js";
import { resolveVaultValue } from "./vault/vault-value.js";

const packageVersion = "0.1.0";

const globalOptions = (command: Command): GlobalOptions =>
  globalOptionsSchema.parse(command.optsWithGlobals());

const context = async (command: Command) => {
  const options = globalOptions(command);
  const apiUrl = resolveApiUrl(options.apiUrl);
  const output = createOutput(options.json);
  const credential = await resolveCredential(apiUrl, options);
  return {
    apiUrl,
    client: createApiClient(apiUrl, credential),
    credential,
    options,
    output,
  };
};

const addSyncOptions = (command: Command): Command =>
  command
    .option("--dry-run", "Validate and describe operations without mutation")
    .option(
      "--no-enable",
      "Disable only newly created agents; leave existing agents' enabled state unchanged"
    )
    .option("--message <message>", "Version message")
    .option("--concurrency <number>", "Maximum parallel bundles", "1")
    .option(
      "--continue-on-error",
      "Continue other bundles after a synchronization failure"
    );

const handleResults = (
  results: Awaited<ReturnType<typeof syncBundles>>,
  command: Command
): void => {
  const output = createOutput(globalOptions(command).json);
  output.data(results);
  if (results.some((result) => result.status === "failed")) {
    throw new CliError("One or more agents failed to synchronize.", 3);
  }
};

export const createProgram = (): Command => {
  const program = new Command()
    .name("aleph")
    .description("Publish and manage Aleph agents")
    .version(packageVersion)
    .option("--api-url <url>", "Aleph API origin")
    .option("--api-key <key>", "Aleph user or organization API key")
    .option("--json", "Emit machine-readable JSON");

  program
    .command("login")
    .description("Authenticate through the Aleph browser flow")
    .option("--api-url <url>", "Aleph API origin")
    .action(async (_options: unknown, command: Command) => {
      const options = globalOptions(command);
      const apiUrl = resolveApiUrl(options.apiUrl);
      await login(apiUrl, createOutput(options.json));
    });

  program
    .command("logout")
    .description("Remove the stored browser session")
    .action(async (_options: unknown, command: Command) => {
      const options = globalOptions(command);
      const apiUrl = resolveApiUrl(options.apiUrl);
      await credentialStore.remove(apiUrl);
      createOutput(options.json).data(
        options.json
          ? { apiUrl, authenticated: false }
          : `Logged out of ${apiUrl}`
      );
    });

  const auth = program
    .command("auth")
    .description("Inspect CLI authentication");
  auth
    .command("status")
    .description("Verify the active credential")
    .action(async (_options: unknown, command: Command) => {
      const current = await context(command);
      const agents = await agentsApi.list(current.client);
      current.output.data({
        apiUrl: current.apiUrl,
        authenticated: true,
        credential: current.credential.kind,
        visibleAgents: agents.total,
      });
    });

  const agents = program.command("agents").description("Manage Aleph agents");

  const vault = program
    .command("vault")
    .description("Manage Aleph vault values");
  vault
    .command("set <name>")
    .description("Create or update a vault value without printing it")
    .option("--value <value>", "Vault value; prefer --value-stdin in CI")
    .option("--value-stdin", "Read the vault value from standard input")
    .option("--description <description>", "Vault entry description")
    .option("--org <organization-id-or-slug>", "Organization vault scope")
    .option("--team <team-id>", "Team vault scope")
    .action(async (name: string, raw: unknown, command: Command) => {
      const current = await context(command);
      const parsed = z
        .object({
          description: z.string().min(1).optional(),
          org: z.string().min(1).optional(),
          team: z.string().min(1).optional(),
          value: z.string().optional(),
          valueStdin: z.boolean().optional(),
        })
        .refine((value) => !(value.org && value.team), {
          message: "Use only one of --org or --team.",
        })
        .parse(raw);
      const value = await resolveVaultValue(parsed);
      let scope: VaultScope = { kind: "user" };
      if (parsed.org) {
        scope = { id: parsed.org, kind: "org" };
      } else if (parsed.team) {
        scope = { id: parsed.team, kind: "team" };
      }
      const input = parsed.description
        ? { description: parsed.description, name, value }
        : { name, value };
      const entry = await vaultApi.set(current.client, scope, input);
      current.output.data({
        description: entry.description ?? null,
        name: entry.name,
        scope: scope.kind === "user" ? "user" : `${scope.kind}:${scope.id}`,
        updated: true,
      });
    });

  agents
    .command("list")
    .description("List accessible agents")
    .action(async (_options: unknown, command: Command) => {
      const current = await context(command);
      const page = await agentsApi.list(current.client);
      current.output.data(page);
    });

  for (const mode of ["enable", "disable"] as const) {
    agents
      .command(`${mode} <agent-id>`)
      .description(`${mode === "enable" ? "Enable" : "Disable"} an agent`)
      .option("--version-id <id>", "Version to pin when enabling")
      .action(
        async (
          agentId: string,
          raw: { versionId?: string },
          command: Command
        ) => {
          const current = await context(command);
          const parsed = z
            .object({ versionId: z.string().min(1).optional() })
            .parse(raw);
          const result =
            mode === "enable"
              ? await agentsApi.enable(
                  current.client,
                  agentId,
                  parsed.versionId
                )
              : await agentsApi.disable(current.client, agentId);
          current.output.data(result);
        }
      );
  }

  addSyncOptions(
    agents.command("push [directory]").description("Publish one agent bundle")
  ).action(
    async (directory: string | undefined, raw: unknown, command: Command) => {
      const current = await context(command);
      const bundle = resolve(directory ?? ".");
      await readAgentManifest(bundle);
      const results = await syncBundles({
        apiUrl: current.apiUrl,
        bundles: [bundle],
        client: current.client,
        options: syncOptionsSchema.parse(raw),
        output: current.output,
        stateRoot: process.cwd(),
      });
      handleResults(results, command);
    }
  );

  agents
    .command("pull [directory]")
    .description(
      "Download the pinned (or latest) version into a local bundle and stamp versionId"
    )
    .action(async (directory: string | undefined, command: Command) => {
      const current = await context(command);
      const bundle = resolve(directory ?? ".");
      const result = await pullBundle({
        client: current.client,
        directory: bundle,
        output: current.output,
      });
      current.output.data(result);
    });

  addSyncOptions(
    agents
      .command("sync [directory]")
      .description("Synchronize every agent bundle in a repository")
  ).action(
    async (directory: string | undefined, raw: unknown, command: Command) => {
      const current = await context(command);
      const discovered = await discoverBundles(directory ?? ".");
      const results = await syncBundles({
        apiUrl: current.apiUrl,
        bundles: discovered.bundles,
        client: current.client,
        options: syncOptionsSchema.parse(raw),
        output: current.output,
        stateRoot: discovered.stateRoot,
      });
      handleResults(results, command);
    }
  );

  return program;
};
