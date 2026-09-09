import type {
  SkillContextAttributionFact,
  SkillInvocationFact,
  SkillTelemetrySink,
} from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { skillContextAttributions, skillInvocations } from "../schema/index.js";

/** Build the app-owned persistence port for one organization. */
export function skillTelemetrySink(db: AppDb, orgId: string): SkillTelemetrySink {
  return {
    async recordInvocation(fact: SkillInvocationFact): Promise<void> {
      await db
        .insert(skillInvocations)
        .values({
          id: fact.id,
          createdAt: fact.createdAt,
          orgId,
          sessionId: fact.sessionId,
          threadId: fact.threadId,
          invokerUserId: fact.invokerUserId,
          invocationEntryId: fact.invocationEntryId,
          path: fact.path,
          skillKey: fact.skillKey,
          skillName: fact.skillName,
          storedSkillId: fact.storedSkillId,
          pluginName: fact.pluginName,
          origin: fact.origin,
          contentSha: fact.contentSha,
          injectedCharacters: fact.injectedCharacters,
          estimatedBodyTokens: fact.estimatedBodyTokens,
        })
        .onConflictDoNothing();
    },

    async recordContextAttributions(facts: SkillContextAttributionFact[]): Promise<void> {
      if (facts.length === 0) return;
      await db
        .insert(skillContextAttributions)
        .values(
          facts.map((fact) => ({
            skillInvocationId: fact.skillInvocationId,
            llmRequestId: fact.llmRequestId,
            sessionId: fact.sessionId,
            threadId: fact.threadId,
            createdAt: fact.createdAt,
            estimatedSkillTokens: fact.estimatedSkillTokens,
          })),
        )
        .onConflictDoNothing();
    },
  };
}
