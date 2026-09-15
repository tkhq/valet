import { describe, expect, it } from "vitest";
import {
  agentSigningPolicy,
  clampWindowMinutes,
  formatWindow,
  githubKeyTitle,
  signingGateRequest,
  signingGateResumeKey,
} from "./gate.js";

describe("signing gate", () => {
  it("renders every value of the scope without abbreviation", () => {
    const req = signingGateRequest({ repo: "tkhq/valet", branch: "valet/x", prNumber: 42, windowMinutes: 120 });
    expect(req.type).toBe("credential_request");
    expect(req.title).toBe("Sign commits");
    expect(req.body).toBe(
      "Sign commits in tkhq/valet, branch valet/x (pull request #42), valid for 2 h?\n" +
        "The key is deleted after the window or when the pull request closes.",
    );
    expect(req.actions?.map((a) => a.id)).toEqual(["approve", "reject"]);
    expect(req.actions?.[0]?.approves).toBe(true);
    expect(req.resumeKey).toBe("signing-key:tkhq/valet:valet/x");
    expect(req.context).toEqual({ repo: "tkhq/valet", branch: "valet/x", prNumber: 42, windowMinutes: 120 });
  });

  it("omits the pull request when there is none", () => {
    const req = signingGateRequest({ repo: "a/b", branch: "main", windowMinutes: 45 });
    expect(req.body).toContain("Sign commits in a/b, branch main, valid for 45 min?");
    expect(req.context).not.toHaveProperty("prNumber");
  });

  it("keys the gate on repo and branch so a retry joins the same gate", () => {
    expect(signingGateResumeKey({ repo: "a/b", branch: "feat" })).toBe("signing-key:a/b:feat");
  });
});

describe("window", () => {
  it("defaults, floors, and caps", () => {
    expect(clampWindowMinutes(undefined)).toBe(120);
    expect(clampWindowMinutes(Number.NaN)).toBe(120);
    expect(clampWindowMinutes(0)).toBe(1);
    expect(clampWindowMinutes(90.9)).toBe(90);
    expect(clampWindowMinutes(100_000)).toBe(1440);
  });

  it("formats hours and minutes", () => {
    expect(formatWindow(120)).toBe("2 h");
    expect(formatWindow(90)).toBe("1 h 30 min");
    expect(formatWindow(45)).toBe("45 min");
  });
});

describe("github key title", () => {
  it("names the session, the pull request, and the expiry", () => {
    const title = githubKeyTitle(
      "sess-1",
      { repo: "tkhq/valet", branch: "x", prNumber: 7, windowMinutes: 60 },
      new Date("2026-09-12T10:00:00Z"),
    );
    expect(title).toBe("valet session sess-1 tkhq/valet#7 until 2026-09-12T10:00:00.000Z");
  });
});

describe("agent signing policy", () => {
  it("uses tag ids in both the condition and the consensus", () => {
    const p = agentSigningPolicy("tag-agent", "tag-signing");
    expect(p.effect).toBe("EFFECT_ALLOW");
    expect(p.condition).toBe(
      "activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' && private_key.tags.contains('tag-signing')",
    );
    expect(p.consensus).toBe("approvers.any(user, user.tags.contains('tag-agent'))");
  });
});
