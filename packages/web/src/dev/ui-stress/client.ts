import { FrozenQueryClient } from "./frozen-query-client";
import { resolveUiStressFixture, seedUiStressCache } from "./seed";

/** A frozen client seeded with every gallery fixture. */
export function createUiStressClient(): FrozenQueryClient {
  const client = new FrozenQueryClient(resolveUiStressFixture);
  seedUiStressCache(client);
  return client;
}

/** The one client the gallery page and its app shell share. */
export const uiStressClient = createUiStressClient();
