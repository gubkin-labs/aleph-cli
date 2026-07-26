import createClient, { defaultPathSerializer } from "openapi-fetch";

import type { paths } from "../generated/schema.js";

export type AuthCredential =
  | { readonly kind: "api-key"; readonly value: string }
  | { readonly kind: "session"; readonly value: string };

export const pathSerializer = (
  pathname: string,
  pathParams: Record<string, unknown>
): string => {
  let url = defaultPathSerializer(
    pathname,
    pathParams as Record<string, string>
  );

  for (const [name, value] of Object.entries(pathParams ?? {})) {
    if (value === undefined || value === null) {
      continue;
    }
    url = url.replace(`:${name}`, encodeURIComponent(String(value)));
  }

  return url;
};

export const createApiClient = (
  apiUrl: string,
  credential: AuthCredential
): ReturnType<typeof createClient<paths>> =>
  createClient<paths>({
    baseUrl: apiUrl,
    headers:
      credential.kind === "api-key"
        ? { "x-api-key": credential.value }
        : { Authorization: `Bearer ${credential.value}` },
    pathSerializer,
  });
