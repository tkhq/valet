import { describe, expect, it } from "vitest";
import {
  acceptFiles,
  createComposerFile,
  formatSize,
  toFileRefs,
  type ComposerFile,
} from "./composer-files";

describe("composer-files", () => {
  describe("formatSize", () => {
    it("formats bytes", () => {
      expect(formatSize(512)).toBe("512 bytes");
    });

    it("formats kilobytes", () => {
      expect(formatSize(5120)).toBe("5 KB");
    });

    it("formats megabytes", () => {
      expect(formatSize(5242880)).toBe("5 MB");
    });
  });

  describe("acceptFiles", () => {
    it("accepts a valid file", () => {
      const result = acceptFiles([], [{ name: "test.pdf", size: 1024 }]);
      expect(result.accepted).toHaveLength(1);
      expect(result.rejected).toHaveLength(0);
    });

    it("rejects a file that exceeds the single-file limit", () => {
      const result = acceptFiles([], [{ name: "huge.zip", size: 60 * 1024 * 1024 }]);
      expect(result.accepted).toHaveLength(0);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]).toContain("limit");
    });

    it("respects the count limit", () => {
      const current: ComposerFile[] = Array.from({ length: 5 }, (_, i) => ({
        id: `file-${i}`,
        name: `file${i}.txt`,
        bytes: 1024,
        file: new File([], `file${i}.txt`),
      }));
      const result = acceptFiles(current, [{ name: "one-more.txt", size: 1024 }]);
      expect(result.accepted).toHaveLength(0);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]).toContain("5 files");
    });

    it("respects the total size limit", () => {
      const current: ComposerFile[] = [
        {
          id: "file-1",
          name: "large.txt",
          bytes: 200 * 1024 * 1024,
          file: new File([], "large.txt"),
        },
      ];
      const result = acceptFiles(current, [{ name: "more.txt", size: 100 * 1024 * 1024 }]);
      expect(result.accepted).toHaveLength(0);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]).toContain("limit");
    });
  });

  describe("createComposerFile", () => {
    it("creates a file from a File object", () => {
      const file = new File(["content"], "test.txt", { type: "text/plain" });
      const composer = createComposerFile(file);
      expect(composer.name).toBe("test.txt");
      expect(composer.bytes).toBe(7);
      expect(composer.file).toBe(file);
      expect(composer.attachmentRef).toBeUndefined();
      expect(composer.error).toBeUndefined();
    });
  });

  describe("toFileRefs", () => {
    it("extracts refs from uploaded files", () => {
      const files: ComposerFile[] = [
        { id: "1", name: "a.pdf", bytes: 100, file: new File([], "a.pdf"), attachmentRef: "att_abc" },
        { id: "2", name: "b.txt", bytes: 50, file: new File([], "b.txt") }, // no ref
        { id: "3", name: "c.zip", bytes: 200, file: new File([], "c.zip"), attachmentRef: "att_def" },
      ];
      const refs = toFileRefs(files);
      expect(refs).toHaveLength(2);
      expect(refs[0]).toEqual({ ref: "att_abc" });
      expect(refs[1]).toEqual({ ref: "att_def" });
    });

    it("returns empty array when no files have refs", () => {
      const files: ComposerFile[] = [
        { id: "1", name: "a.pdf", bytes: 100, file: new File([], "a.pdf") },
      ];
      const refs = toFileRefs(files);
      expect(refs).toHaveLength(0);
    });
  });
});
