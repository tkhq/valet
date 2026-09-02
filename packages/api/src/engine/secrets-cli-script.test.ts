import { describe, expect, it } from "vitest";
import { secretsCliScript } from "./secrets-cli-script.js";

// The constant is generated from a shell source with two placeholders. A
// regeneration from an already-substituted copy once baked a probe host into
// every sandbox, and the CLI failed with "Could not resolve host".
describe("secretsCliScript", () => {
  it("bakes in the api url it is given and nothing else", () => {
    const out = secretsCliScript("http://host.docker.internal:8788");
    expect(out).toContain('API="http://host.docker.internal:8788"');
    expect(out).not.toContain("__VALET_API_URL__");
    expect(out).not.toContain("__TOKEN_READ__");
    expect(out).not.toMatch(/http:\/\/api:|127\.0\.0\.1:8\d{3}|localhost:8\d{3}/);
  });

  it("reads the token from the creds mount, then the environment", () => {
    const out = secretsCliScript("http://x:1");
    expect(out).toContain("tok=$(cat /etc/valet/creds/token 2>/dev/null)");
    expect(out).toContain('[ -n "$tok" ] || tok=${VALET_SANDBOX_TOKEN:-}');
    expect(out).toContain("unset VALET_SANDBOX_TOKEN");
  });
});
