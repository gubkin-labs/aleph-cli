import { AsyncEntry } from "@napi-rs/keyring";

const SERVICE = "com.aleph-agent.cli";

const entryFor = (apiUrl: string): AsyncEntry =>
  new AsyncEntry(SERVICE, apiUrl);

export const credentialStore = {
  async get(apiUrl: string): Promise<string | null> {
    try {
      return (await entryFor(apiUrl).getPassword()) ?? null;
    } catch {
      return null;
    }
  },
  async remove(apiUrl: string): Promise<void> {
    try {
      await entryFor(apiUrl).deleteCredential();
    } catch {
      // Missing credentials already represent the desired logged-out state.
    }
  },
  async set(apiUrl: string, token: string): Promise<void> {
    await entryFor(apiUrl).setPassword(token);
  },
};

export type CredentialStore = typeof credentialStore;
