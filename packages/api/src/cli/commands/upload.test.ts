import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExitCode } from "../exit.js";
import { parseGlobalFlags } from "../output.js";
import { formatBytes, parseUploadArgs, prepareUploadFiles, shortSha256 } from "./upload.js";

describe("upload command", () => {
  describe("parseUploadArgs", () => {
    it("requires session id and at least one path", () => {
      const result = parseUploadArgs({ rest: [], flags: {}, json: false });
      expect(typeof result).toBe("string");
      expect(result).toMatch(/session id and at least one file path/);
    });

    it("parses session id and single file", () => {
      const result = parseUploadArgs({ rest: ["sess_abc", "file.txt"], flags: {}, json: false });
      expect(typeof result).not.toBe("string");
      if (typeof result !== "string") {
        expect(result.sessionId).toBe("sess_abc");
        expect(result.paths).toEqual(["file.txt"]);
        expect(result.extract).toBe("auto");
        expect(result.overwrite).toBe(false);
        expect(result.message).toBeUndefined();
      }
    });

    it("parses multiple files", () => {
      const result = parseUploadArgs({
        rest: ["sess_abc", "file1.txt", "file2.pdf"],
        flags: {},
        json: false,
      });
      expect(typeof result).not.toBe("string");
      if (typeof result !== "string") {
        expect(result.paths).toEqual(["file1.txt", "file2.pdf"]);
      }
    });

    it("rejects --dest with multiple files", () => {
      const result = parseUploadArgs({
        rest: ["sess_abc", "file1.txt", "file2.txt"],
        flags: { dest: "/tmp/target" },
        json: false,
      });
      expect(typeof result).toBe("string");
      expect(result).toMatch(/--dest is only valid with exactly one file/);
    });

    it("accepts --dest with single file", () => {
      const result = parseUploadArgs({
        rest: ["sess_abc", "file.txt"],
        flags: { dest: "/workspace/uploads/custom.txt" },
        json: false,
      });
      expect(typeof result).not.toBe("string");
      if (typeof result !== "string") {
        expect(result.dest).toBe("/workspace/uploads/custom.txt");
      }
    });

    it("parses --extract flag", () => {
      const autoResult = parseUploadArgs({
        rest: ["sess_abc", "file.zip"],
        flags: { extract: "auto" },
        json: false,
      });
      expect(typeof autoResult).not.toBe("string");
      if (typeof autoResult !== "string") {
        expect(autoResult.extract).toBe("auto");
      }

      const trueResult = parseUploadArgs({
        rest: ["sess_abc", "file.zip"],
        flags: { extract: "true" },
        json: false,
      });
      expect(typeof trueResult).not.toBe("string");
      if (typeof trueResult !== "string") {
        expect(trueResult.extract).toBe("true");
      }

      const falseResult = parseUploadArgs({
        rest: ["sess_abc", "file.zip"],
        flags: { extract: "false" },
        json: false,
      });
      expect(typeof falseResult).not.toBe("string");
      if (typeof falseResult !== "string") {
        expect(falseResult.extract).toBe("false");
      }
    });

    it("rejects invalid --extract value", () => {
      const result = parseUploadArgs({
        rest: ["sess_abc", "file.zip"],
        flags: { extract: "invalid" },
        json: false,
      });
      expect(typeof result).toBe("string");
      expect(result).toMatch(/--extract must be auto, true, or false/);
    });

    it("parses --overwrite flag", () => {
      const result = parseUploadArgs({
        rest: ["sess_abc", "file.txt"],
        flags: { overwrite: true },
        json: false,
      });
      expect(typeof result).not.toBe("string");
      if (typeof result !== "string") {
        expect(result.overwrite).toBe(true);
      }
    });

    it("parses --message flag", () => {
      const result = parseUploadArgs({
        rest: ["sess_abc", "file.txt"],
        flags: { message: "summarize this" },
        json: false,
      });
      expect(typeof result).not.toBe("string");
      if (typeof result !== "string") {
        expect(result.message).toBe("summarize this");
      }
    });

    it("parses --json flag", () => {
      const result = parseUploadArgs({
        rest: ["sess_abc", "file.txt"],
        flags: {},
        json: true,
      });
      expect(typeof result).not.toBe("string");
      if (typeof result !== "string") {
        expect(result.json).toBe(true);
      }
    });
  });

  describe("prepareUploadFiles", () => {
    it("threads --extract and --overwrite into every file info", async () => {
      const dir = await mkdtemp(join(tmpdir(), "valet-upload-"));
      const file = join(dir, "a.zip");
      await writeFile(file, "PK");

      const files = await prepareUploadFiles([file], undefined, "false", true);
      expect(files).toHaveLength(1);
      expect(files[0].extract).toBe("false");
      expect(files[0].overwrite).toBe(true);
    });

    it("defaults extract to auto and overwrite to false", async () => {
      const dir = await mkdtemp(join(tmpdir(), "valet-upload-"));
      const file = join(dir, "b.txt");
      await writeFile(file, "hi");

      const files = await prepareUploadFiles([file]);
      expect(files[0].extract).toBe("auto");
      expect(files[0].overwrite).toBe(false);
    });
  });

  describe("formatBytes", () => {
    it("formats bytes", () => {
      expect(formatBytes(512)).toBe("512 bytes");
    });

    it("formats kilobytes", () => {
      expect(formatBytes(5120)).toBe("5 KB");
      expect(formatBytes(1536)).toBe("1.5 KB");
    });

    it("formats megabytes", () => {
      expect(formatBytes(5242880)).toBe("5 MB");
      expect(formatBytes(2621440)).toBe("2.5 MB");
    });
  });

  describe("shortSha256", () => {
    it("shortens sha256 with prefix", () => {
      expect(shortSha256("sha256:9f2c1a3b...")).toBe("9f2c1a3b");
    });

    it("shortens bare sha256", () => {
      expect(shortSha256("9f2c1a3b...")).toBe("9f2c1a3b");
    });
  });
});
