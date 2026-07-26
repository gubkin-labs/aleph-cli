# Aleph CLI

Publish and manage [Aleph](https://www.aleph-agent.com) agents from a terminal
or CI workflow.

```bash
npx @gubkin-labs/aleph-cli login
npx @gubkin-labs/aleph-cli agents push ./my-agent
ALEPH_API_KEY=... npx @gubkin-labs/aleph-cli agents sync . --json
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

## Releases

Every push to `main` runs the release workflow after the full quality suite.
semantic-release publishes at least a patch release for every push; conventional
`feat` and breaking commits still select minor and major versions. The workflow
publishes `@gubkin-labs/aleph-cli` to npm and creates the matching GitHub release.
Standalone executable packaging is intentionally separate because those
artifacts must be built on their corresponding operating-system runners.

Publishing uses npm trusted publishing. Configure npm with the GitHub repository
`gubkin-labs/aleph-cli` and workflow `.github/workflows/release.yml`. Because npm
trusted publishers are configured on an existing package, bootstrap the first
publication with an npm automation token if the package has never been
published; subsequent releases use GitHub OIDC without a long-lived token.

### Commit messages

All commits must follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/):

```text
<type>[optional scope][!]: <description>
```

Examples: `fix(auth): clear revoked sessions`, `feat(agents): add batch sync`,
and `feat(api)!: replace upload response`. Husky validates messages locally,
and CI validates every commit in a push or pull request so bypassing local hooks
does not bypass the convention.
