import type { SkillSource } from "../types.js";
import {
  BUILTIN_COMMAND_NAMES,
  type CommandDef,
  type CommandInfo,
  type PromptTemplate,
  type RegistryDiagnostic,
  type ResolvedCommand,
} from "./types.js";

export interface BuildRegistryInput {
  skills: SkillSource[];
  templates: PromptTemplate[];
  pluginCommands: Array<{ pluginName: string; def: CommandDef }>;
  bareSkillNames: boolean;
}

export interface CommandRegistry {
  list(): CommandInfo[];
  diagnostics(): RegistryDiagnostic[];
  resolve(name: string): ResolvedCommand | undefined;
  nearMiss(name: string): string | undefined;
}

interface BuiltinMeta {
  description: string;
  argHint?: string;
}

const BUILTIN_META: Record<(typeof BUILTIN_COMMAND_NAMES)[number], BuiltinMeta> = {
  help: { description: "List available commands" },
  status: { description: "Show session status" },
  stop: { description: "Abort the current agent turn" },
  clear: { description: "Clear the prompt queue" },
  model: { description: "Switch model or list choices", argHint: "[model-id]" },
  compact: { description: "Compact the thread context", argHint: "[instructions]" },
  "new-thread": { description: "Start a fresh thread" },
  sessions: { description: "List child sessions" },
};

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  // Use a single row DP approach
  const prev: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  const curr: number[] = new Array(n + 1) as number[];

  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] ?? n) + 1,
        (prev[j] ?? m) + 1,
        (prev[j - 1] ?? m + n) + cost,
      );
    }
    for (let j = 0; j <= n; j++) {
      prev[j] = curr[j] ?? 0;
    }
  }
  return prev[n] ?? Math.max(m, n);
}

export function buildCommandRegistry(input: BuildRegistryInput): CommandRegistry {
  const { skills, templates, pluginCommands, bareSkillNames } = input;
  const map = new Map<string, ResolvedCommand>();
  const infos: CommandInfo[] = [];
  const diags: RegistryDiagnostic[] = [];

  function register(name: string, resolved: ResolvedCommand, info: CommandInfo): void {
    map.set(name, resolved);
    infos.push(info);
  }

  function overwrite(
    name: string,
    resolved: ResolvedCommand,
    info: CommandInfo,
    prevSource: string,
  ): void {
    diags.push({
      name,
      message: `"${name}" shadows a previous registration (${prevSource})`,
    });
    // Replace existing info entry for this name
    const idx = infos.findIndex((i) => i.name === name);
    if (idx !== -1) {
      infos.splice(idx, 1);
    }
    map.set(name, resolved);
    infos.push(info);
  }

  // 1. Built-ins
  for (const bname of BUILTIN_COMMAND_NAMES) {
    const meta = BUILTIN_META[bname];
    const resolved: ResolvedCommand = { source: "builtin", name: bname };
    const info: CommandInfo = {
      name: bname,
      description: meta.description,
      source: "builtin",
      ...(meta.argHint !== undefined ? { argHint: meta.argHint } : {}),
    };
    register(bname, resolved, info);
  }

  // 2. Plugin commands: ${pluginName}:${def.name}
  for (const { pluginName, def } of pluginCommands) {
    const name = `${pluginName}:${def.name}`;
    const resolved: ResolvedCommand = { source: "plugin", pluginName, def };
    const info: CommandInfo = {
      name,
      description: def.description,
      source: "plugin",
      ...(def.argHint !== undefined ? { argHint: def.argHint } : {}),
    };
    register(name, resolved, info);
  }

  // 3. Skills: always under skill:${name}; also bare when bareSkillNames
  for (const skill of skills) {
    const prefixedName = `skill:${skill.name}`;
    const prefixedResolved: ResolvedCommand = { source: "skill", skill, bare: false };
    const prefixedInfo: CommandInfo = {
      name: prefixedName,
      description: skill.description ?? skill.name,
      source: "skill",
    };
    register(prefixedName, prefixedResolved, prefixedInfo);

    if (bareSkillNames) {
      const bareName = skill.name;
      const bareResolved: ResolvedCommand = { source: "skill", skill, bare: true };
      const bareInfo: CommandInfo = {
        name: bareName,
        description: skill.description ?? skill.name,
        source: "skill",
      };
      if (map.has(bareName)) {
        const existing = map.get(bareName);
        overwrite(bareName, bareResolved, bareInfo, existing?.source ?? "unknown");
      } else {
        register(bareName, bareResolved, bareInfo);
      }
    }
  }

  // 4. Templates: repo first, then user (user overwrites repo, recording a diagnostic)
  const repoTemplates = templates.filter((t) => t.origin === "repo");
  const userTemplates = templates.filter((t) => t.origin === "user");

  for (const tmpl of repoTemplates) {
    const resolved: ResolvedCommand = { source: "template", template: tmpl };
    const info: CommandInfo = {
      name: tmpl.name,
      description: tmpl.description ?? tmpl.name,
      source: "template",
    };
    if (map.has(tmpl.name)) {
      const existing = map.get(tmpl.name);
      overwrite(tmpl.name, resolved, info, existing?.source ?? "unknown");
    } else {
      register(tmpl.name, resolved, info);
    }
  }

  for (const tmpl of userTemplates) {
    const resolved: ResolvedCommand = { source: "template", template: tmpl };
    const info: CommandInfo = {
      name: tmpl.name,
      description: tmpl.description ?? tmpl.name,
      source: "template",
    };
    if (map.has(tmpl.name)) {
      const existing = map.get(tmpl.name);
      overwrite(tmpl.name, resolved, info, existing?.source ?? "unknown");
    } else {
      register(tmpl.name, resolved, info);
    }
  }

  return {
    list(): CommandInfo[] {
      return [...infos];
    },
    diagnostics(): RegistryDiagnostic[] {
      return [...diags];
    },
    resolve(name: string): ResolvedCommand | undefined {
      return map.get(name);
    },
    nearMiss(name: string): string | undefined {
      if (map.has(name)) return undefined;
      const names = [...map.keys()];
      let best: string | undefined;
      let bestDist = Infinity;
      for (const candidate of names) {
        const dist = levenshtein(name, candidate);
        if (dist < bestDist) {
          bestDist = dist;
          best = candidate;
        }
      }
      return bestDist <= 2 ? best : undefined;
    },
  };
}
