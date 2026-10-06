import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { ActionPlugin, BlobStore, PluginAction, SessionStore } from "@valet/engine";
import { PROFILE_PICTURE_MAX_BYTES } from "../wire/types.js";
import { normalizeProfilePicture } from "./profile-picture-image.js";

const parameters = Type.Object({
  message_id: Type.Optional(Type.String({ description: "User message containing the photo, from this chat's recent history. Omit to use the latest image upload." })),
  image_index: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based image number in that message. Defaults to 0." })),
});

/** Only host-stamped session/thread IDs can select the source attachment. */
export function profilePictureActions(store: SessionStore, blobs: BlobStore, publicUrl: () => string | undefined): ActionPlugin {
  const publish: PluginAction<typeof parameters> = {
    id: "profile_pictures.publish_avatar",
    name: "Publish Chat Photo as Avatar",
    description: "Use a photo uploaded to this chat as a workflow's Slack avatar. Only call when asked to use that photo as an avatar. Publishes a resized copy at a public URL; the original chat stays private. Save the returned avatar_url as sender_avatar_url in the workflow. Reads the last 50 chat entries; ask for a fresh upload if the photo is older.",
    riskLevel: "high",
    parameters,
    async execute(args, ctx) {
      if (ctx.externalSender) return { success: false, error: "Link your Valet account before publishing an avatar." };
      let origin: string;
      try {
        const url = new URL(publicUrl() ?? "");
        if (url.protocol !== "https:") throw new Error("HTTPS required");
        origin = url.origin;
      } catch {
        return { success: false, error: "Configure Valet's public HTTPS URL before publishing avatars." };
      }
      const session = await store.getSession(ctx.sessionId);
      if (!session || session.orgId !== ctx.orgId) return { success: false, error: "Open the chat containing the photo and try again." };
      const entries = await store.getEntries(ctx.sessionId, ctx.threadId, { limit: 50 });
      const source = entries.reverse().find((entry) => (!args.message_id || entry.id === args.message_id)
        && (entry.type === "message" && entry.role === "user" && entry.attachments?.some((attachment) => attachment.type === "image")
          || entry.type === "decision_gate" && entry.gate.type === "question" && entry.resolution?.attachments?.length));
      const image = source?.type === "message" ? source.attachments?.filter((attachment) => attachment.type === "image")[args.image_index ?? 0]
        : source?.type === "decision_gate" ? source.resolution?.attachments?.map((attachment) => ({ ...attachment, type: "image" as const, data: undefined }))[args.image_index ?? 0] : undefined;
      if (!image || image.type !== "image") return { success: false, error: "Upload the selected photo to this chat, then try again with its image number." };
      let input = image.data;
      if (!input && image.url?.startsWith("data:")) {
        if (image.url.length > Math.ceil(PROFILE_PICTURE_MAX_BYTES / 3) * 4 + 128) {
          return { success: false, error: "Choose an image smaller than 5 MB and upload it again." };
        }
        const match = /^data:([^;]+);base64,([A-Za-z0-9+/]+=*)$/.exec(image.url);
        if (match && match[1] === image.mimeType) input = new Uint8Array(Buffer.from(match[2], "base64"));
      }
      if (!input) return { success: false, error: "Attach the photo directly to this chat instead of linking to a remote file." };
      const normalized = await normalizeProfilePicture(input, image.mimeType);
      if ("error" in normalized) return { success: false, error: normalized.error };
      // Content and source scope make retries stable without overwriting an older avatar.
      const hash = createHash("sha256").update(JSON.stringify([ctx.orgId, ctx.sessionId, ctx.threadId, source?.id])).update(normalized.data).digest("hex");
      await blobs.put(`profile-pictures/workflows/${hash}.webp`, normalized.data, { contentType: "image/webp" });
      return { success: true, data: { avatar_url: `${origin}/avatars/workflows/${hash}.webp` } };
    },
  };
  return { service: "profile_pictures", actions: [publish] };
}
