import { describe, expect, it } from "vitest";
import { userInitials } from "./user-initials";

describe("userInitials", () => {
  it("takes up to two initials from a name", () => {
    expect(userInitials("Bob Smith")).toBe("BS");
    expect(userInitials("Alice")).toBe("A");
    expect(userInitials("Ana Maria Costa")).toBe("AM");
  });

  it("uses only the local part of an email — the domain is not the person", () => {
    expect(userInitials("bob@example.com")).toBe("B");
    expect(userInitials("bob.smith@example.com")).toBe("BS");
  });

  it("takes whole code points, not UTF-16 units, for non-BMP leading chars", () => {
    expect(userInitials("😀John Smith")).toBe("😀S");
  });

  it("falls back to '?' when the label has no usable characters", () => {
    expect(userInitials("   ")).toBe("?");
  });
});
