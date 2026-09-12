import { describe, expect, it } from "vitest";
import { valetSignScript } from "./commit-signing-script.js";

describe("valetSignScript", () => {
  const script = valetSignScript();

  it("is deterministic POSIX sh that execs tk ssh git-sign with git's arguments", () => {
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(valetSignScript()).toBe(script);
    expect(script).toContain('exec "$TK" ssh git-sign "$@"');
  });

  it("hands every operation except signing to ssh-keygen", () => {
    expect(script).toContain('*"-Y sign"*) ;;');
    expect(script).toContain('*) exec ssh-keygen "$@" ;;');
  });

  it("reads the session key and the env file from the fixed paths and embeds no secret", () => {
    expect(script).toContain('ENV_FILE="/run/valet/turnkey/env"');
    expect(script).toContain('KEY_FILE="/run/valet/turnkey/session.json"');
    expect(script).toContain('TK="/usr/local/bin/tk"');
    expect(script).not.toMatch(/TURNKEY_API_PRIVATE_KEY=['"][0-9a-f]/);
  });

  it("names the corrective action for each missing piece", () => {
    expect(script).toContain("tk is not installed in this sandbox image");
    expect(script).toContain("no Turnkey session key");
    expect(script).toContain("Call turnkey.request_signing_key first, or commit with --no-gpg-sign.");
  });
});
