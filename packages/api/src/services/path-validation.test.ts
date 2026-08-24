import { describe, it, expect } from "vitest";
import { resolveUploadDest } from "./path-validation.js";

describe("resolveUploadDest", () => {
  describe("default behavior", () => {
    it("uses default /workspace/uploads/<filename> when dest is undefined", () => {
      const result = resolveUploadDest("report.pdf");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe("/workspace/uploads/report.pdf");
      }
    });
  });

  describe("directory dest handling", () => {
    it("appends basename to dest when dest ends with /", () => {
      const result = resolveUploadDest("data.txt", "/workspace/uploads/");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe("/workspace/uploads/data.txt");
      }
    });

    it("appends basename when dest ends with multiple slashes", () => {
      const result = resolveUploadDest("file.zip", "/workspace/uploads//");
      expect(result.ok).toBe(true);
      if (result.ok) {
        // normalize() will clean up multiple slashes
        expect(result.path).toContain("file.zip");
      }
    });
  });

  describe("traversal attacks", () => {
    it("rejects ../ prefix", () => {
      const result = resolveUploadDest("evil.txt", "../etc/passwd");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("..");
      }
    });

    it("rejects .. in middle", () => {
      const result = resolveUploadDest("evil.txt", "/workspace/uploads/../../../etc/passwd");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("..");
      }
    });

    it("rejects .. even in normalized form", () => {
      const result = resolveUploadDest("evil.txt", "/workspace/uploads/../../etc/passwd");
      expect(result.ok).toBe(false);
    });
  });

  describe("null byte injection", () => {
    it("rejects path with null byte", () => {
      const result = resolveUploadDest("evil.txt", "/workspace/uploads/file\x00.txt");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("null");
      }
    });
  });

  describe("workspace containment", () => {
    it("rejects absolute path outside /workspace/", () => {
      const result = resolveUploadDest("evil.txt", "/etc/passwd");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("/workspace/");
      }
    });

    it("rejects /tmp paths", () => {
      const result = resolveUploadDest("evil.txt", "/tmp/file.txt");
      expect(result.ok).toBe(false);
    });

    it("rejects leading double slash", () => {
      const result = resolveUploadDest("evil.txt", "//etc/passwd");
      expect(result.ok).toBe(false);
    });
  });

  describe("root write rejection", () => {
    it("accepts /workspace/ as directory and appends basename", () => {
      const result = resolveUploadDest("file.txt", "/workspace/");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe("/workspace/file.txt");
      }
    });

    it("rejects /workspace (without trailing slash) as it normalizes to exactly /workspace", () => {
      const result = resolveUploadDest("file.txt", "/workspace");
      expect(result.ok).toBe(false);
    });
  });

  describe("valid cases", () => {
    it("accepts explicit /workspace/x.txt", () => {
      const result = resolveUploadDest("ignored.txt", "/workspace/x.txt");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe("/workspace/x.txt");
      }
    });

    it("accepts /workspace/subdir/file.txt", () => {
      const result = resolveUploadDest("ignored.txt", "/workspace/uploads/report.pdf");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toBe("/workspace/uploads/report.pdf");
      }
    });

    it("accepts nested directories", () => {
      const result = resolveUploadDest("file.txt", "/workspace/data/nested/deep/file.txt");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.path).toContain("/workspace/");
      }
    });
  });
});
