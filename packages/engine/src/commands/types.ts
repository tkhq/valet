import type { SkillSource } from "../types.js";

export type CommandSource = "builtin" | "skill" | "template" | "plugin";

export interface CommandInfo {
  /** Invocation name without the leading slash: "status", "skill:review", "linear:create-issue". */
  name: string;
  description: string;
  source: CommandSource;
  argHint?: string;
}

export interface RegistryDiagnostic {
  name: string;
  message: string;
}

/** Action-backed plugin command (v1). Declared in ValetPlugin.commands. */
export interface CommandDef {
  name: string;
  description: string;
  argHint?: string;
  /** Action id from the same plugin. Validated at manifest load. */
  action: string;
  mapArgs: (args: string[], raw: string) => Record<string, unknown>;
}

export interface PromptTemplate {
  name: string;
  description?: string;
  content: string;
  origin: "repo" | "user";
}

/** Host-injected template sources. Same injection pattern as SpecProvider. */
export interface TemplateProvider {
  listTemplates(): Promise<PromptTemplate[]>;
}

/** Host capabilities for built-ins the engine cannot answer alone. */
export interface CommandContext {
  listModels(): Promise<Array<{ id: string; name: string }>>;
  listChildSessions(): Promise<Array<{ id: string; title?: string; status: string }>>;
}

export type ResolvedCommand =
  | { source: "builtin"; name: string }
  | { source: "skill"; skill: SkillSource; bare: boolean }
  | { source: "template"; template: PromptTemplate }
  | { source: "plugin"; pluginName: string; def: CommandDef };
