/**
 * Unit tests for the artifact read-authorization matrix. Every branch of
 * `decideArtifactAccess` lives here because the HTTP layer cannot exercise
 * anonymity in stub-auth mode (the stub answers for everyone) — see
 * `resolveOptionalUser` in `middleware/auth.ts`.
 */
import { describe, it, expect } from "vitest";
import { decideArtifactAccess } from "./artifacts.js";

const orgArtifact = { orgId: "org-1", visibility: "org" as const, revokedAt: null };
const publicArtifact = { orgId: "org-1", visibility: "public" as const, revokedAt: null };
const member = { orgId: "org-1" };
const outsider = { orgId: "org-2" };

describe("decideArtifactAccess", () => {
  it("404s a missing artifact for everyone", () => {
    expect(decideArtifactAccess({ artifact: undefined, allowPublicArtifacts: true, user: member })).toEqual({
      kind: "not_found",
    });
  });

  it("404s a revoked artifact even for its own org, even when public", () => {
    const revoked = { ...publicArtifact, revokedAt: 123 };
    expect(decideArtifactAccess({ artifact: revoked, allowPublicArtifacts: true, user: member })).toEqual({
      kind: "not_found",
    });
    expect(decideArtifactAccess({ artifact: revoked, allowPublicArtifacts: true, user: undefined })).toEqual({
      kind: "not_found",
    });
  });

  it("serves an org artifact to a logged-in org member", () => {
    expect(decideArtifactAccess({ artifact: orgArtifact, allowPublicArtifacts: false, user: member })).toEqual({
      kind: "serve",
    });
  });

  it("asks anonymous callers to log in for an org artifact", () => {
    expect(decideArtifactAccess({ artifact: orgArtifact, allowPublicArtifacts: false, user: undefined })).toEqual({
      kind: "login",
    });
  });

  it("404s (not 403) a logged-in caller from another org — existence-hiding", () => {
    expect(decideArtifactAccess({ artifact: orgArtifact, allowPublicArtifacts: false, user: outsider })).toEqual({
      kind: "not_found",
    });
  });

  it("serves a public artifact anonymously while the org opt-in is on", () => {
    expect(decideArtifactAccess({ artifact: publicArtifact, allowPublicArtifacts: true, user: undefined })).toEqual({
      kind: "serve",
    });
  });

  it("re-gates a public artifact to org auth the moment the opt-in is off", () => {
    // The live-check rule: no sweep flips rows back — the read path itself
    // must fall back to the `org` ladder when the setting is off.
    expect(decideArtifactAccess({ artifact: publicArtifact, allowPublicArtifacts: false, user: undefined })).toEqual({
      kind: "login",
    });
    expect(decideArtifactAccess({ artifact: publicArtifact, allowPublicArtifacts: false, user: member })).toEqual({
      kind: "serve",
    });
    expect(decideArtifactAccess({ artifact: publicArtifact, allowPublicArtifacts: false, user: outsider })).toEqual({
      kind: "not_found",
    });
  });
});
