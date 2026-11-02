import { posix } from 'node:path';
import { Type } from 'typebox';
import type { Static } from 'typebox';
import type { PluginActionContext } from '@valet/engine';
import {
  attachmentFilename,
  attachmentLimitError,
  attachmentMimeType,
  type MimeAttachment,
} from './mime.js';

const AttachmentRef = Type.Object({
  threadFileId: Type.Optional(Type.String({
    minLength: 1,
    description:
      'ID of a file saved in this thread: threadFileId from drive.export_file, or id from file_attach. A download URL of a thread file also works.',
  })),
  path: Type.Optional(Type.String({
    minLength: 1,
    description: 'Absolute path of a file in the working directory, for example /workspace/out/sow.pdf or /workspace/uploads/brief.docx.',
  })),
  filename: Type.Optional(Type.String({
    minLength: 1,
    description: 'Optional file name the recipient sees. Default: the saved file name.',
  })),
}, { additionalProperties: false });

export type AttachmentRef = Static<typeof AttachmentRef>;

/** The `attachments` list shared by every Gmail action that builds a message. */
export function attachmentList(description: string) {
  return Type.Array(AttachmentRef, {
    minItems: 1,
    maxItems: 20,
    description:
      `${description} Each item names one file with threadFileId or path. ` +
      'To attach a Google Drive file, first save it with drive.export_file (Google Docs become PDF) and pass its threadFileId. ' +
      'Gmail limits attachments to 25 MB in total.',
  });
}

/** `attachmentList` for actions where attachments are optional. */
export function attachmentsParam(description: string) {
  return Type.Optional(attachmentList(description));
}

/** What a result reports about each attached file. */
export function describeAttachments(attachments: MimeAttachment[]) {
  return attachments.map((a) => ({ filename: a.filename, mimeType: a.mimeType, bytes: a.data.byteLength }));
}

const THREAD_FILE_ID = /(?:^|\/files\/)([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[?#].*)?$/i;

type Resolved = { ok: true; attachments: MimeAttachment[] } | { ok: false; error: string };

/**
 * Read each referenced file into memory, in order. Fails on the first
 * missing or unreadable file, and before reading a file that would take
 * the total past Gmail's limit. `attachedBytes` counts attachments the
 * message already has.
 */
export async function resolveAttachments(
  refs: AttachmentRef[] | undefined,
  ctx: PluginActionContext,
  attachedBytes = 0,
): Promise<Resolved> {
  const attachments: MimeAttachment[] = [];
  let total = attachedBytes;
  for (const [index, ref] of (refs ?? []).entries()) {
    const label = `Attachment ${index + 1}`;
    if ((ref.threadFileId === undefined) === (ref.path === undefined)) {
      return { ok: false, error: `${label}: give exactly one of threadFileId or path.` };
    }

    let name: string;
    let declaredType: string | undefined;
    let data: Uint8Array;
    if (ref.threadFileId !== undefined) {
      const id = THREAD_FILE_ID.exec(ref.threadFileId.trim())?.[1]?.toLowerCase();
      if (!id) {
        return { ok: false, error: `${label}: "${ref.threadFileId}" is not a thread file ID. Use threadFileId from drive.export_file or id from file_attach.` };
      }
      if (!ctx.threadFiles) {
        return { ok: false, error: `${label}: this session cannot read thread files. Attach the file by its path instead.` };
      }
      const file = await ctx.threadFiles.read(id);
      if (!file) {
        return {
          ok: false,
          error: `${label}: no file with ID ${id} is saved in this thread. Save it again with drive.export_file or file_attach, or attach it by path.`,
        };
      }
      total += file.bytes;
      const limit = attachmentLimitError(total);
      if (limit) return { ok: false, error: limit };
      ({ name, data } = file);
      declaredType = file.mimeType;
    } else {
      const path = ref.path ?? '';
      if (!posix.isAbsolute(path) || /[\x00-\x1f\x7f]/.test(path)) {
        return { ok: false, error: `${label}: use an absolute file path, for example /workspace/out/report.pdf.` };
      }
      let stat: { isFile: boolean; size: number };
      try {
        stat = await ctx.sandbox.stat(path);
      } catch {
        return { ok: false, error: `${label}: cannot read ${path}. Check that the file exists in the working directory, or attach a saved thread file by threadFileId.` };
      }
      if (!stat.isFile) return { ok: false, error: `${label}: ${path} is not a file. Give the path of a file.` };
      const limit = attachmentLimitError(total + stat.size);
      if (limit) return { ok: false, error: limit };
      data = await ctx.sandbox.readBinary(path);
      total += data.byteLength;
      // The file can grow between stat and read.
      const grown = attachmentLimitError(total);
      if (grown) return { ok: false, error: grown };
      name = posix.basename(path);
    }

    const filename = attachmentFilename(ref.filename ?? name);
    attachments.push({ filename, mimeType: attachmentMimeType(filename, declaredType), data });
  }
  return { ok: true, attachments };
}
