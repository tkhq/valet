import { describe, expect, it } from "vitest";
import { ApiError } from "~/api/client";
import { errorText, UNAVAILABLE_TEXT } from "./error-text";

describe("errorText", () => {
  it("prefers the api's corrective action, then its error", () => {
    expect(errorText(new ApiError(400, "POST → 400", { error: "unknown attachment ref r1", corrective: "Re-upload the file and retry." })))
      .toBe("Re-upload the file and retry.");
    expect(errorText(new ApiError(503, "POST → 503", { error: "Registry is at capacity. Try again later." })))
      .toBe("Registry is at capacity. Try again later.");
  });

  it("names the outage when no api answered", () => {
    expect(errorText(new TypeError("Failed to fetch"))).toBe(UNAVAILABLE_TEXT);
    expect(errorText(new ApiError(502, "PUT /api/settings → 502", "<html>Bad Gateway</html>"))).toBe(UNAVAILABLE_TEXT);
  });

  it("keeps the request line for an api error without a message", () => {
    expect(errorText(new ApiError(500, "GET /api/x → 500", "Internal Server Error"))).toBe("GET /api/x → 500");
  });
});
