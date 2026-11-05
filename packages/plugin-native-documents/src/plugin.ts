import { readFileSync } from "node:fs";
import { loadSkillFromMarkdown, type ValetPlugin } from "@valet/engine";

// Keep literal asset URLs so the API binary build can inline these skills.
const docx = readFileSync(new URL("../skills/native-docx/SKILL.md", import.meta.url), "utf8");
const xlsx = readFileSync(new URL("../skills/native-xlsx/SKILL.md", import.meta.url), "utf8");
const pptx = readFileSync(new URL("../skills/native-pptx/SKILL.md", import.meta.url), "utf8");
const pdf = readFileSync(new URL("../skills/native-pdf/SKILL.md", import.meta.url), "utf8");

const plugin: ValetPlugin = {
  name: "native-documents",
  version: "0.0.1",
  skills: [
    loadSkillFromMarkdown(docx, "plugin", "native-docx"),
    loadSkillFromMarkdown(xlsx, "plugin", "native-xlsx"),
    loadSkillFromMarkdown(pptx, "plugin", "native-pptx"),
    loadSkillFromMarkdown(pdf, "plugin", "native-pdf"),
  ],
};

export default plugin;
