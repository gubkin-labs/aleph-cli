# Aleph CLI

Publish and manage [Aleph](https://www.aleph-agent.com) agents from a terminal
or CI workflow.

```bash
npx @aleph-agent/cli login
npx @aleph-agent/cli agents push ./my-agent
ALEPH_API_KEY=... npx @aleph-agent/cli agents sync . --json
```

Global installation and the standalone release binaries expose the same
`aleph` command.

## Authentication

`aleph login` opens the Aleph browser authorization page and stores the
resulting session in macOS Keychain, Windows Credential Manager, or the Linux
Secret Service. CI should provide a user or organization API key through
`ALEPH_API_KEY`. A `--api-key` flag takes precedence, followed by the
environment variable and then the stored browser session.

The API origin defaults to `https://api.aleph-agent.com`; override it with
`ALEPH_API_URL` or `--api-url`.

## Agent manifests

Each bundle contains a sync-only `aleph.json`:

```json
{
  "agentId": "optional-existing-id",
  "name": "Repository assistant",
  "description": "Understands this repository.",
  "labels": ["Engineering"],
  "visibility": "private",
  "icon": "cover.jpg"
}
```

`aleph agents push [directory]` publishes one bundle. `aleph agents sync
[directory]` discovers `agents/*/aleph.json`, direct child manifests, or a root
manifest shaped as `{ "agents": ["path/to/agent"] }`.

Remote IDs are resolved only from `agentId` or `.aleph/state.json`; display
names are never used as identity. Synchronization creates or updates metadata,
uploads a version, and enables that exact version. Use `--no-enable` for
catalog templates, `--dry-run` to validate without mutations, and
`--continue-on-error` for batch processing.

## Development

```bash
pnpm install
pnpm openapi
pnpm quality
pnpm package:binaries
```

The application API client is generated from Aleph’s `/doc` OpenAPI document.
