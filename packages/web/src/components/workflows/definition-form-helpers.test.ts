import { describe, expect, it } from "vitest";
import { ApiError } from "~/api/client";
import { extractValidationErrors, parseDefinitionInput } from "./definition-form-helpers";

describe("parseDefinitionInput", () => {
  it("parses valid JSON", () => {
    const result = parseDefinitionInput('{"version":"dag/v1"}');
    expect(result).toEqual({ ok: true, value: { version: "dag/v1" } });
  });

  it("reports an error for invalid JSON", () => {
    const result = parseDefinitionInput("{not json");
    expect(result.ok).toBe(false);
  });
});

describe("extractValidationErrors", () => {
  it("extracts the errors array from a 400 ApiError payload", () => {
    const err = new ApiError(400, "POST /workflows → 400", {
      error: "invalid workflow definition",
      errors: ["duplicate node id: a", "unknown edge target: b"],
    });
    expect(extractValidationErrors(err)).toEqual([
      "duplicate node id: a",
      "unknown edge target: b",
    ]);
  });

  it("falls back to the ApiError message when there's no errors array", () => {
    const err = new ApiError(404, "workflow not found");
    expect(extractValidationErrors(err)).toEqual(["workflow not found"]);
  });

  it("falls back to a generic message for a non-Error value", () => {
    expect(extractValidationErrors("boom")).toEqual(["Something went wrong."]);
  });
});
