import { describe, expect, it } from "vitest";
import plugin from "./plugin.js";

describe("native document skills", () => {
  it("loads all four formats without a credential declaration", () => {
    expect(plugin.name).toBe("native-documents");
    expect(plugin.credentials).toBeUndefined();
    expect(plugin.skills?.map((skill) => skill.name)).toEqual([
      "native-docx", "native-xlsx", "native-pptx", "native-pdf",
    ]);
    for (const skill of plugin.skills ?? []) {
      expect(skill.source).toBe("plugin");
      expect(skill.description).toContain("native");
      expect(skill.content).toContain("/opt/valet-office/bin/python");
      expect(skill.content).toContain("Preserve the original file");
      expect(skill.content).toContain("Google Workspace tools");
      expect(skill.content).toContain("office.py validate");
      expect(skill.content).toContain("pdftoppm");
      expect(skill.content).toContain("file_attach");
    }
  });

  it("includes format-specific limits that generic file validation cannot check", () => {
    const content = (name: string) => plugin.skills?.find((skill) => skill.name === name)?.content;
    expect(content("native-docx")).toContain("Tracked changes");
    expect(content("native-xlsx")).toContain("does not calculate formulas");
    expect(content("native-pptx")).toContain("Animations, transitions, SmartArt");
    expect(content("native-pdf")).toContain("Do not claim a covered rectangle is a redaction");
  });
});
