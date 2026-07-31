import { z } from "zod";

import { CliError } from "../errors.js";

const organizationSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  slug: z.string().min(1),
});

const sessionSchema = z.object({
  session: z.object({
    activeOrganizationId: z.string().nullable().optional(),
  }),
  user: z.object({
    email: z.string().optional(),
    name: z.string().optional(),
  }),
});

const authErrorSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
  message: z.string().optional(),
});

export type Organization = z.infer<typeof organizationSchema>;
export type AuthSession = z.infer<typeof sessionSchema>;

const bearerHeaders = (token: string): HeadersInit => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
});

const errorFrom = async (response: Response): Promise<CliError> => {
  const parsed = authErrorSchema.safeParse(
    await response.json().catch(() => ({}))
  );
  const error = parsed.success ? parsed.data : {};
  const message =
    error.error_description ??
    error.message ??
    error.error ??
    `Organization request failed with HTTP ${response.status}`;
  return new CliError(message, 2);
};

export const listOrganizations = async (
  apiUrl: string,
  token: string
): Promise<Organization[]> => {
  const response = await fetch(`${apiUrl}/api/auth/organization/list`, {
    headers: bearerHeaders(token),
    method: "GET",
  });
  if (!response.ok) {
    throw await errorFrom(response);
  }
  return z.array(organizationSchema).parse(await response.json());
};

export const setActiveOrganization = async (
  apiUrl: string,
  token: string,
  organizationId: string | null
): Promise<Organization | null> => {
  const response = await fetch(`${apiUrl}/api/auth/organization/set-active`, {
    body: JSON.stringify({ organizationId }),
    headers: bearerHeaders(token),
    method: "POST",
  });
  if (!response.ok) {
    throw await errorFrom(response);
  }
  const body: unknown = await response.json();
  if (body === null) {
    return null;
  }
  return organizationSchema.parse(body);
};

export const getAuthSession = async (
  apiUrl: string,
  token: string
): Promise<AuthSession> => {
  const response = await fetch(`${apiUrl}/api/auth/get-session`, {
    headers: bearerHeaders(token),
    method: "GET",
  });
  if (!response.ok) {
    throw await errorFrom(response);
  }
  const body: unknown = await response.json();
  if (body === null) {
    throw new CliError("No active session. Run `aleph login`.", 2);
  }
  return sessionSchema.parse(body);
};

export const resolveOrganizationRef = (
  organizations: readonly Organization[],
  ref: string
): Organization | undefined => {
  const normalized = ref.trim().toLowerCase();
  return organizations.find(
    (organization) =>
      organization.id.toLowerCase() === normalized ||
      organization.slug.toLowerCase() === normalized
  );
};
