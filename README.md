# Aleph CLI

Publish and manage [Aleph](https://www.aleph-agent.com) agents from a terminal
or CI workflow.

```bash
npx @gubkin-labs/aleph-cli login
npx @gubkin-labs/aleph-cli agents push ./my-agent
ALEPH_API_KEY=... npx @gubkin-labs/aleph-cli agents sync . --json
printf '%s' "$TOKEN" | ALEPH_API_KEY=... npx @gubkin-labs/aleph-cli vault set GH_TOKEN --value-stdin
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

## Vault

`aleph vault set <name>` creates or updates a vault value without printing the
value. By default it targets the authenticated user's vault; use
`--org <id-or-slug>` or `--team <id>` for a scoped vault. Pass
`--value <value>` for local use, or
prefer `--value-stdin` for CI so the secret is not present in command arguments:

```bash
printf '%s' "$ALEPH_REPOS_TOKEN" | aleph vault set GH_TOKEN \
  --org aleph-featured-agents-org \
  --value-stdin \
  --description "Repository token for Aleph CMO"
```

## Agent manifests

Each bundle contains a sync-only `aleph.json`:

```json
{
  "agentId": "5c5b86cf-b0d6-4e30-a9a0-58292e3afd59",
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

`agentId` is a required UUID and the only create/update identity. On first
sync Aleph creates that exact ID; later syncs update it. If the field is
missing, the CLI prints a generated UUID and the exact JSON field to add.
Display names and `.aleph/state.json` are never identity fallbacks.
`agents sync` treats the discovered folders
as the source of truth: it archives any previously synchronized bundle that is
no longer present locally, then removes its saved ID. If that archived agent
was already deleted, sync reports a warning and continues. Synchronization
creates or updates metadata and uploads the runtime bundle. If its file paths,
bytes, and `aleph.json` metadata match the latest version, the CLI reports
`unchanged` and does not create, enable, disable, or repin a version. `agentId`
is excluded from this comparison because it is identity, not versioned metadata.
`.aleph/state.json` remains only
for reconciling bundle folders removed from Git.
Use `--no-enable` for catalog templates, `--dry-run` to validate without
mutations, and `--continue-on-error` for batch processing.

## Development

```bash
pnpm install
pnpm openapi
pnpm quality
pnpm package:binaries
```

The application API client is generated from Aleph’s `/doc` OpenAPI document.

## Releases

Every push to `main` runs the release workflow after the full quality suite.
semantic-release publishes at least a patch release for every push; conventional
`feat` and breaking commits still select minor and major versions. The workflow
updates `package.json`, creates the version tag, and publishes the matching
GitHub release. It does not publish to npm.
Standalone executable packaging is intentionally separate because those
artifacts must be built on their corresponding operating-system runners.

After semantic-release commits a version, publish it manually from an
authenticated local checkout:

```bash
git pull
pnpm install --frozen-lockfile
pnpm quality
npm publish --access public
```

The release commit uses `chore(release): <version> [skip ci]`, which satisfies
commitlint and prevents a recursive workflow run.

### Commit messages

All commits must follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

```text
<type>[optional scope][!]: <description>
```

Examples: `fix(auth): clear revoked sessions`, `feat(agents): add batch sync`,
and `feat(api)!: replace upload response`. Husky validates messages locally,
and CI validates every commit in a push or pull request so bypassing local hooks
does not bypass the convention.
