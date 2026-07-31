import { render } from "ink";

import { CliError } from "../errors.js";
import type { Output } from "../output.js";
import { OrgSelectView } from "./org-select-view.js";
import {
  getAuthSession,
  listOrganizations,
  type Organization,
  resolveOrganizationRef,
  setActiveOrganization,
} from "./organization-client.js";

export interface OrganizationScopeResult {
  readonly organizationId: string | null;
  readonly organizationName: string | null;
  readonly scope: "organization" | "personal";
}

export interface OrganizationScopeSelection {
  readonly org?: string;
  readonly personal?: boolean;
}

const scopeLabel = (result: OrganizationScopeResult): string =>
  result.scope === "personal"
    ? "Personal"
    : (result.organizationName ?? result.organizationId ?? "organization");

export const formatScopeResult = (
  apiUrl: string,
  result: OrganizationScopeResult
): string => `Logged in to ${apiUrl} as ${scopeLabel(result)}`;

const promptOrganization = async (
  organizations: readonly Organization[]
): Promise<string | null> => {
  const options = [
    { label: "Personal", value: null as string | null },
    ...organizations.map((organization) => ({
      label: `${organization.name} (${organization.slug})`,
      value: organization.id,
    })),
  ];

  return await new Promise<string | null>((resolve, reject) => {
    const view = render(
      <OrgSelectView
        onSelect={(value) => {
          view.unmount();
          resolve(value);
        }}
        options={options}
      />,
      { stdout: process.stderr }
    );
    view.waitUntilExit().catch(reject);
  });
};

export const selectAndApplyOrganizationScope = async (input: {
  readonly apiUrl: string;
  readonly output: Output;
  readonly selection?: OrganizationScopeSelection;
  readonly token: string;
}): Promise<OrganizationScopeResult> => {
  const organizations = await listOrganizations(input.apiUrl, input.token);
  const selection = input.selection ?? {};

  if (selection.personal && selection.org) {
    throw new CliError("Use only one of --org or --personal.", 1);
  }

  let organizationId: string | null = null;
  let organizationName: string | null = null;

  if (selection.personal) {
    organizationId = null;
  } else if (selection.org) {
    const matched = resolveOrganizationRef(organizations, selection.org);
    if (!matched) {
      throw new CliError(
        `Organization "${selection.org}" was not found in your memberships.`,
        1
      );
    }
    organizationId = matched.id;
    organizationName = matched.name;
  } else if (organizations.length === 0) {
    organizationId = null;
  } else if (process.stderr.isTTY && !input.output.json) {
    organizationId = await promptOrganization(organizations);
    if (organizationId) {
      organizationName =
        organizations.find((organization) => organization.id === organizationId)
          ?.name ?? null;
    }
  } else {
    organizationId = null;
    input.output.progress(
      "No --org/--personal flag; keeping Personal scope (non-interactive)."
    );
  }

  const active = await setActiveOrganization(
    input.apiUrl,
    input.token,
    organizationId
  );
  if (active) {
    organizationName = active.name;
    organizationId = active.id;
  }

  return {
    organizationId,
    organizationName,
    scope: organizationId ? "organization" : "personal",
  };
};

export const describeActiveScope = async (input: {
  readonly apiUrl: string;
  readonly token: string;
}): Promise<OrganizationScopeResult> => {
  const [session, organizations] = await Promise.all([
    getAuthSession(input.apiUrl, input.token),
    listOrganizations(input.apiUrl, input.token),
  ]);
  const organizationId = session.session.activeOrganizationId ?? null;
  if (!organizationId) {
    return {
      organizationId: null,
      organizationName: null,
      scope: "personal",
    };
  }
  const matched = organizations.find(
    (organization) => organization.id === organizationId
  );
  return {
    organizationId,
    organizationName: matched?.name ?? null,
    scope: "organization",
  };
};
