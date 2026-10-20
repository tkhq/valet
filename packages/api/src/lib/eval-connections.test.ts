import { describe, expect, it } from "vitest";
import { InMemoryCredentialStore } from "@valet/engine";
import { connectEvalPlaceholders, EVAL_PLACEHOLDER_SECRET } from "./eval-connections.js";

const user = { type: "user" as const, id: "u1" };
const org = { type: "org" as const, id: "o1" };

describe("connectEvalPlaceholders", () => {
  it("gives Slack an org bot token and Google its OAuth client settings", async () => {
    const credentials = new InMemoryCredentialStore();
    const env: Record<string, string | undefined> = {};
    const { envNames } = await connectEvalPlaceholders({
      credentials,
      userId: user.id,
      orgId: org.id,
      services: ["slack", "google_workspace"],
      env,
    });

    expect((await credentials.get(org, "slack"))?.accessToken).toBe(EVAL_PLACEHOLDER_SECRET);
    expect(await credentials.get(user, "slack")).not.toBeNull();
    expect(envNames.length).toBeGreaterThan(0);
    for (const name of envNames) expect(env[name]).toBe(EVAL_PLACEHOLDER_SECRET);
  });

  it("keeps an environment variable that is already set", async () => {
    const credentials = new InMemoryCredentialStore();
    const first: Record<string, string | undefined> = {};
    const { envNames } = await connectEvalPlaceholders({ credentials, userId: user.id, orgId: org.id, services: ["gmail"], env: first });
    const env = Object.fromEntries(envNames.map((name) => [name, "real"]));
    const second = await connectEvalPlaceholders({ credentials, userId: user.id, orgId: org.id, services: ["gmail"], env });
    expect(second.envNames).toEqual([]);
    expect(Object.values(env)).toEqual(envNames.map(() => "real"));
  });

  it("refuses an MCP service and changes nothing", async () => {
    const credentials = new InMemoryCredentialStore();
    const env: Record<string, string | undefined> = {};
    await expect(
      connectEvalPlaceholders({ credentials, userId: user.id, orgId: org.id, services: ["gmail", "linear"], env }),
    ).rejects.toThrow(/linear/);
    expect(env).toEqual({});
    expect(await credentials.get(user, "gmail")).toBeNull();
  });
});
