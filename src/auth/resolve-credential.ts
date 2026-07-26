import type { AuthCredential } from "../api/client.js";
import type { GlobalOptions } from "../config.js";
import { AuthenticationError } from "../errors.js";
import type { CredentialStore } from "./credential-store.js";
import { credentialStore } from "./credential-store.js";

export const resolveCredential = async (
  apiUrl: string,
  options: GlobalOptions,
  store: CredentialStore = credentialStore
): Promise<AuthCredential> => {
  const apiKey = options.apiKey ?? process.env.ALEPH_API_KEY;
  if (apiKey?.trim()) {
    return { kind: "api-key", value: apiKey.trim() };
  }

  const token = await store.get(apiUrl);
  if (token) {
    return { kind: "session", value: token };
  }
  throw new AuthenticationError();
};
