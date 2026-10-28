import { describe, expect, it } from "vitest";
import { SOURCE_HEALTH_GUIDANCE, sourceHealthGuidance, sourceHealthPhrase } from "./source-health.js";

describe("source health guidance", () => {
  it("has the eight spec 11.2 lines and none for ok", () => {
    expect(Object.keys(SOURCE_HEALTH_GUIDANCE).sort()).toEqual(["bake_failed", "contract", "contract_unknown", "credentials", "registry_full", "repo_unreachable", "resolve_failed", "waiting_for_base"]);
    expect(sourceHealthGuidance("ok")).toBeNull();
    expect(sourceHealthGuidance("contract")).toBe("The image was built before a runtime change. A rebuild is already queued.");
  });
  it("renders the row phrase per health", () => {
    const now = 10 * 60 * 60 * 1000;
    expect(sourceHealthPhrase("healthy", "ok", now - 2 * 60 * 60 * 1000, now)).toBe("Healthy, built 2h ago");
    expect(sourceHealthPhrase("stale", "ok", null, now)).toBe("Rebuilding");
    expect(sourceHealthPhrase("stale", "waiting_for_base", null, now)).toBe("Rebuilding");
    expect(sourceHealthPhrase("incompatible", "contract", null, now)).toBe("Unusable: image predates the current runtime");
    expect(sourceHealthPhrase("failing", "repo_unreachable", null, now)).toBe("Failing: The Valet GitHub app lost access. Reinstall it on this repository.");
    expect(sourceHealthPhrase("unbaked", "ok", null, now)).toBe("Not built yet");
  });
});
