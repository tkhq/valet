import type { CredentialStore } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { prepareModelTierPatch, saveModelTierPatch } from "./model-tier-settings.js";
import { renameOrg } from "./org.js";

/** Validate the complete request, then save organization settings atomically. */
export async function patchOrganizationSettings(db: AppDb, credentials: CredentialStore, orgId: string, parsed: unknown): Promise<{ success: true } | { error: string }> {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: "Send a JSON object with organization settings." };
  }
  const unknownFields = Object.keys(parsed).filter((key) => key !== "name" && key !== "defaultTier");
  if (unknownFields.length > 0) {
    return { error: `Unknown field(s): ${unknownFields.join(", ")}. Send name or defaultTier.` };
  }
  const name = "name" in parsed ? parsed.name : undefined;
  if (name !== undefined && typeof name !== "string") {
    return { error: "Organization name must be a string. Send the organization name as text." };
  }
  if (name !== undefined && name.trim().length === 0) {
    return { error: "Organization name cannot be blank. Enter a name with at least one non-whitespace character." };
  }
  if (name?.includes("\u0000")) {
    return { error: "Organization name cannot contain NUL characters. Remove them and try again." };
  }
  const tierPatch = "defaultTier" in parsed ? { defaultTier: parsed.defaultTier } : null;
  if (name === undefined && tierPatch === null) {
    return { error: "Send name or defaultTier to change organization settings." };
  }
  const prepared = tierPatch === null ? null : await prepareModelTierPatch(db, credentials, orgId, tierPatch);
  if (prepared && "error" in prepared) return prepared;

  return db.transaction(async (tx) => {
    if (prepared) {
      const result = await saveModelTierPatch(tx, orgId, prepared);
      if ("error" in result) return result;
    }
    if (name !== undefined) await renameOrg(tx, orgId, name);
    return { success: true };
  });
}
