/**
 * `.valet/credentials.yaml` parsing. The rule throughout: a malformed
 * declaration throws rather than being dropped. A silently ignored entry
 * leaves the agent with a command that looks wrapped and quietly does not
 * authenticate, which is the exact failure the file exists to remove.
 */
import { describe, expect, it } from "vitest";
import { CREDENTIAL_COMMANDS_PATH, loadCredentialCommands } from "./credential-commands.js";

const reader = (body: string | null) => async (path: string) =>
  path === CREDENTIAL_COMMANDS_PATH ? body : null;

describe("loadCredentialCommands", () => {
  it("returns null when the repo has no file — the ordinary case, not an error", async () => {
    expect(await loadCredentialCommands(reader(null))).toBeNull();
  });

  it("reads a pinned reference and a name to search for", async () => {
    const got = await loadCredentialCommands(
      reader(`commands:
  - command: stripe
    env: STRIPE_API_KEY
    reference: op://Eng/Stripe/secret key
  - command: aws
    env: AWS_SECRET_ACCESS_KEY
    credential: aws
`),
    );
    expect(got).toEqual([
      { command: "stripe", env: "STRIPE_API_KEY", reference: "op://Eng/Stripe/secret key" },
      { command: "aws", env: "AWS_SECRET_ACCESS_KEY", credential: "aws" },
    ]);
  });

  it("treats an empty document and an absent commands key as no declarations", async () => {
    expect(await loadCredentialCommands(reader(""))).toEqual([]);
    expect(await loadCredentialCommands(reader("other: 1\n"))).toEqual([]);
  });

  // Exactly one source per command. Both is ambiguous about which wins;
  // neither resolves nothing and would install a wrapper that does nothing.
  it("rejects an entry with both a reference and a credential, or with neither", async () => {
    await expect(
      loadCredentialCommands(
        reader("commands:\n  - command: a\n    env: A\n    reference: op://v/i/f\n    credential: a\n"),
      ),
    ).rejects.toThrow(/exactly one of reference or credential/);
    await expect(
      loadCredentialCommands(reader("commands:\n  - command: a\n    env: A\n")),
    ).rejects.toThrow(/exactly one of reference or credential/);
  });

  it("rejects a command name that is not a bare filename", async () => {
    for (const command of ["../gh", "a/b", "with space", ""]) {
      await expect(
        loadCredentialCommands(
          reader(`commands:\n  - command: ${JSON.stringify(command)}\n    env: A\n    reference: op://v/i/f\n`),
        ),
        command,
      ).rejects.toThrow(/bare command name/);
    }
  });

  it("rejects an environment variable name a shell would not accept", async () => {
    for (const env of ["1BAD", "has-dash", "has space", ""]) {
      await expect(
        loadCredentialCommands(
          reader(`commands:\n  - command: c\n    env: ${JSON.stringify(env)}\n    reference: op://v/i/f\n`),
        ),
        env,
      ).rejects.toThrow(/environment variable name/);
    }
  });

  it("rejects a reference that is not an op:// path", async () => {
    await expect(
      loadCredentialCommands(
        reader("commands:\n  - command: c\n    env: A\n    reference: /etc/passwd\n"),
      ),
    ).rejects.toThrow(/op:\/\/ secret reference/);
  });

  it("rejects the same command declared twice, rather than picking one", async () => {
    await expect(
      loadCredentialCommands(
        reader(
          "commands:\n  - command: gh\n    env: A\n    reference: op://v/i/f\n  - command: gh\n    env: B\n    reference: op://v/i/g\n",
        ),
      ),
    ).rejects.toThrow(/declared more than once/);
  });

  it("rejects a document that is not a mapping, and a commands key that is not a list", async () => {
    await expect(loadCredentialCommands(reader("- a\n- b\n"))).rejects.toThrow(/YAML mapping/);
    await expect(loadCredentialCommands(reader("commands: nope\n"))).rejects.toThrow(/must be a list/);
  });
});
