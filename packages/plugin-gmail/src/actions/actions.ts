import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import type {
  ActionPlugin,
  PluginAction,
  PluginActionContext,
  PluginActionResult,
  SourceInput,
} from "@valet/engine";
import { gmailFetch, decodeBase64Url, decodeBase64UrlBytes, submitRawMessage } from "./api.js";
import { appendAttachments, buildMimeMessage, type MimeAttachment } from "./mime.js";
import { attachmentList, attachmentsParam, describeAttachments, resolveAttachments } from "./attachments.js";

// ─── Internal Types ──────────────────────────────────────────────────────────

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  historyId?: string;
  internalDate?: string;
  sizeEstimate?: number;
  payload?: GmailMessagePayload;
  /** Base64url RFC 5322 bytes, present only for `format=raw`. */
  raw?: string;
}

interface GmailMessagePayload {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { attachmentId?: string; size?: number; data?: string };
  parts?: GmailMessagePayload[];
}

interface GmailDraft {
  id: string;
  message?: GmailMessage;
}

interface GmailLabel {
  id: string;
  name: string;
  type?: string;
  messageListVisibility?: string;
  labelListVisibility?: string;
}

// ─── Error Helper ─────────────────────────────────────────────────────────────

async function gmailError(res: Response): Promise<PluginActionResult> {
  let detail = '';
  try {
    const body = await res.text();
    const json = JSON.parse(body);
    detail = json?.error?.message || body.slice(0, 200);
  } catch {
    detail = res.statusText;
  }
  return { success: false, error: `Gmail API ${res.status}: ${detail}` };
}

/** Fetch reply threading headers for a message. */
async function getReplyContext(
  messageId: string,
  token: string,
): Promise<{ threadId: string | undefined; inReplyTo: string | null; references: string | null }> {
  const qs = new URLSearchParams({
    format: 'metadata',
    metadataHeaders: 'Message-Id',
  });
  // metadataHeaders can appear multiple times
  const url = `/users/me/messages/${messageId}?format=metadata&metadataHeaders=Message-Id&metadataHeaders=References&metadataHeaders=Subject`;
  const res = await gmailFetch(url, token);
  if (!res.ok) throw new Error(`Failed to fetch original message: ${res.status}`);
  const msg = (await res.json()) as GmailMessage;
  const headers = msg.payload?.headers ?? [];
  const findHeader = (name: string) =>
    headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
  const inReplyTo = findHeader('message-id');
  const origRefs = findHeader('references');
  const references = [origRefs, inReplyTo].filter(Boolean).join(' ') || null;
  return { threadId: msg.threadId ?? undefined, inReplyTo, references };
}

/** Build MIME + base64url raw, resolving threading if replyToMessageId is set. */
async function prepareMimeRequest(
  args: {
    to: string | string[];
    subject: string;
    body: string;
    bodyHtml?: string;
    cc?: string[];
    bcc?: string[];
    replyToMessageId?: string;
  },
  token: string,
  attachments: MimeAttachment[] = [],
): Promise<{ message: Uint8Array; threadId: string | undefined; toList: string[] }> {
  const toList = Array.isArray(args.to) ? args.to : [args.to];
  let threadId: string | undefined;
  let inReplyTo: string | null = null;
  let references: string | null = null;

  if (args.replyToMessageId) {
    const ctx = await getReplyContext(args.replyToMessageId, token);
    threadId = ctx.threadId;
    inReplyTo = ctx.inReplyTo;
    references = ctx.references;
  }

  const mime = buildMimeMessage({
    to: toList,
    cc: args.cc,
    bcc: args.bcc,
    subject: args.subject,
    body: args.body,
    bodyHtml: args.bodyHtml,
    inReplyTo,
    references,
    attachments,
  });
  return { message: new Uint8Array(Buffer.from(mime, 'utf8')), threadId, toList };
}

// ─── Body Extraction Helpers ──────────────────────────────────────────────────

function extractMessageBody(payload?: GmailMessagePayload): { text: string; html: string } {
  let text = '';
  let html = '';
  if (!payload) return { text, html };
  const walk = (part: GmailMessagePayload) => {
    const mime = part.mimeType ?? '';
    if (mime === 'text/plain' && part.body?.data) text += decodeBase64Url(part.body.data);
    else if (mime === 'text/html' && part.body?.data) html += decodeBase64Url(part.body.data);
    if (part.parts) for (const sub of part.parts) walk(sub);
  };
  walk(payload);
  return { text, html };
}

function findHeaderValue(
  headers: Array<{ name: string; value: string }> | undefined,
  name: string,
): string | null {
  if (!headers) return null;
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;
}

function collectAttachments(payload?: GmailMessagePayload): Array<{
  partId: string | null;
  filename: string;
  mimeType: string;
  size: number;
  attachmentId: string | null;
}> {
  const out: ReturnType<typeof collectAttachments> = [];
  if (!payload) return out;
  const walk = (part: GmailMessagePayload) => {
    if (part.filename && part.body?.attachmentId) {
      out.push({
        partId: part.partId ?? null,
        filename: part.filename,
        mimeType: part.mimeType ?? 'application/octet-stream',
        size: part.body.size ?? 0,
        attachmentId: part.body.attachmentId ?? null,
      });
    }
    if (part.parts) for (const sub of part.parts) walk(sub);
  };
  walk(payload);
  return out;
}

/** Bytes of every named file part, the total Gmail counts against its attachment limit. */
function attachedBytes(payload?: GmailMessagePayload): number {
  if (!payload) return 0;
  const own = payload.filename ? payload.body?.size ?? 0 : 0;
  return own + (payload.parts ?? []).reduce((sum, part) => sum + attachedBytes(part), 0);
}

function extractDomain(fromHeader: string | null): string | null {
  if (!fromHeader) return null;
  const match = fromHeader.match(/<?([^@<>\s]+)@([^>\s]+)>?/);
  return match ? match[2].toLowerCase() : null;
}

function truncate(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max) + '…';
}

function messageSources(message: GmailMessage): SourceInput[] {
  if (!message.threadId || !message.snippet?.trim()) return [];
  return [{
    service: 'gmail',
    title: findHeaderValue(message.payload?.headers, 'Subject') || 'Gmail message',
    url: `https://mail.google.com/mail/u/0/#all/${encodeURIComponent(message.threadId)}`,
    snippet: truncate(message.snippet, 500),
  }];
}

/**
 * Curried action builder. The first call binds T from the parameters
 * schema; the second call types `execute`'s args via Static<T>. Splitting
 * the inference into two phases sidesteps TS's contextual-inference depth
 * limit, which otherwise gives up on `args: any` once the file gets long.
 */
function action<TParams extends TSchema>(parameters: TParams) {
  return (rest: {
    id: string;
    name: string;
    description: string;
    riskLevel: PluginAction["riskLevel"];
    label?: PluginAction<TParams>["label"];
    execute: (
      args: Static<TParams>,
      ctx: PluginActionContext,
    ) => Promise<PluginActionResult>;
  }): PluginAction<TParams> => ({ ...rest, parameters });
}

// ─── Credential Helper ─────────────────────────────────────────────────────────

async function getAccessToken(ctx: PluginActionContext): Promise<string> {
  const cred = await ctx.credentials.get();
  return cred?.accessToken ?? "";
}

// ─── Actions ────────────────────────────────────────────────────────────────

// ── Messages ────────────────────────────────────────────────────────────────

const sendEmail = action(
  Type.Object({
    to: Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })], {
      description: 'Recipient email address, or an array of recipient email addresses.',
    }),
    subject: Type.String({ description: 'Email subject line.' }),
    body: Type.String({ description: 'Markdown body of the email. Gmail receives it as text/plain and rendered text/html MIME alternatives unless bodyHtml is provided.' }),
    bodyHtml: Type.Optional(Type.String({
      minLength: 1,
      pattern: '\\S',
      description: 'Optional HTML body. It must contain non-whitespace content. When provided, it replaces the rendered Markdown HTML alternative.',
    })),
    cc: Type.Optional(Type.Array(Type.String(), { description: 'Optional list of Cc recipients.' })),
    bcc: Type.Optional(Type.Array(Type.String(), { description: 'Optional list of Bcc recipients.' })),
    replyToMessageId: Type.Optional(
      Type.String({
        description:
          'Optional Gmail message ID to reply to. When set, the new email is threaded with the original and uses In-Reply-To/References headers.',
      }),
    ),
    attachments: attachmentsParam('Optional files to attach.'),
  }, { additionalProperties: false }),
)({
  id: 'gmail.send_email',
  name: 'Send Email',
  description:
    'Sends an email from the authenticated Gmail account. Gmail sends Markdown body as text/plain and safe rendered HTML unless non-blank bodyHtml overrides the HTML part. Supports cc/bcc, file attachments (thread files or working-directory paths), and optional threading by passing replyToMessageId (which copies threadId and sets In-Reply-To/References so the reply lands in the same thread).',
  riskLevel: 'high',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const files = await resolveAttachments(p.attachments, ctx);
      if (!files.ok) return { success: false, error: files.error };
      const { message, threadId, toList } = await prepareMimeRequest(p, token, files.attachments);
      const res = await submitRawMessage({ path: '/users/me/messages/send', method: 'POST', token, message, threadId, draft: false, signal: ctx.signal });
      if (!res.ok) return gmailError(res);
      const data = (await res.json()) as GmailMessage;
      return {
        success: true,
        data: {
          id: data.id,
          threadId: data.threadId,
          labelIds: data.labelIds ?? [],
          to: toList,
          subject: p.subject,
          ...(files.attachments.length > 0 ? { attachments: describeAttachments(files.attachments) } : {}),
          message: `Email sent to ${toList.join(', ')}.`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const listMessages = action(
  Type.Object({
    maxResults: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100,
        default: 10,
        description: 'Maximum number of messages to return (1-100). Defaults to 10.',
      }),
    ),
    q: Type.Optional(
      Type.String({
        description:
          'Gmail search query using the same syntax as the Gmail search box. Examples: "is:unread", "from:boss@acme.com", "has:attachment newer_than:3d".',
      }),
    ),
    labelIds: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'Only return messages with these label IDs (e.g. ["INBOX"], ["STARRED"]). Use list_labels to discover custom label IDs.',
      }),
    ),
    includeSpamTrash: Type.Optional(
      Type.Boolean({ default: false, description: 'If true, also include messages from SPAM and TRASH.' }),
    ),
  }),
)({
  id: 'gmail.list_messages',
  name: 'List Messages',
  description:
    'Lists Gmail messages for the authenticated user. Supports the full Gmail search syntax via the q parameter (e.g. "is:unread", "from:alice@example.com", "subject:invoice newer_than:7d"). Returns message IDs with sender, subject, date, and snippet for each result.',
  riskLevel: 'low',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const qs = new URLSearchParams({ maxResults: String(p.maxResults ?? 10) });
      if (p.q) qs.set('q', p.q);
      if (p.includeSpamTrash) qs.set('includeSpamTrash', 'true');
      if (p.labelIds?.length) p.labelIds.forEach((id: string) => qs.append('labelIds', id));

      const listRes = await gmailFetch(`/users/me/messages?${qs}`, token);
      if (!listRes.ok) return gmailError(listRes);

      const listData = (await listRes.json()) as {
        messages?: Array<{ id: string }>;
        resultSizeEstimate?: number;
        nextPageToken?: string;
      };

      const messageRefs = listData.messages ?? [];
      if (messageRefs.length === 0) {
        return {
          success: true,
          data: { messages: [], resultSizeEstimate: listData.resultSizeEstimate ?? 0, nextPageToken: null },
        };
      }

      const detailed = await Promise.all(
        messageRefs.map((ref) =>
          gmailFetch(
            `/users/me/messages/${ref.id}?format=metadata&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Subject&metadataHeaders=Date`,
            token,
          ).then((r) => (r.ok ? (r.json() as Promise<GmailMessage>) : null)),
        ),
      );

      const messages = detailed
        .filter((msg): msg is GmailMessage => msg !== null)
        .map((msg) => {
          const headers = msg.payload?.headers;
          return {
            id: msg.id,
            threadId: msg.threadId,
            labelIds: msg.labelIds ?? [],
            snippet: msg.snippet ?? '',
            from: findHeaderValue(headers, 'From'),
            to: findHeaderValue(headers, 'To'),
            subject: findHeaderValue(headers, 'Subject'),
            date: findHeaderValue(headers, 'Date'),
          };
        });

      return {
        success: true,
        sources: detailed.flatMap((msg) => msg ? messageSources(msg) : []),
        data: {
          messages,
          resultSizeEstimate: listData.resultSizeEstimate ?? messages.length,
          nextPageToken: listData.nextPageToken ?? null,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const getMessage = action(
  Type.Object({
    messageId: Type.String({ description: 'The Gmail message ID, typically from list_messages results.' }),
    format: Type.Optional(
      Type.Union([Type.Literal('full'), Type.Literal('metadata'), Type.Literal('minimal')], {
        default: 'full',
        description:
          '"full" returns headers + body + attachments; "metadata" returns headers only; "minimal" returns just labels/snippet.',
      }),
    ),
  }),
)({
  id: 'gmail.get_message',
  name: 'Get Message',
  description:
    'Fetches a single Gmail message by ID with headers, decoded plain-text body, HTML body, and a list of attachments (metadata only). Use list_messages to discover message IDs.',
  riskLevel: 'low',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const format = p.format ?? 'full';
      const res = await gmailFetch(`/users/me/messages/${p.messageId}?format=${format}`, token);
      if (!res.ok) return gmailError(res);
      const msg = (await res.json()) as GmailMessage;
      const headers = msg.payload?.headers;
      const sources = messageSources(msg);

      const base = {
        id: msg.id,
        threadId: msg.threadId,
        labelIds: msg.labelIds ?? [],
        snippet: msg.snippet ?? '',
        historyId: msg.historyId,
        internalDate: msg.internalDate,
        sizeEstimate: msg.sizeEstimate,
      };

      if (format === 'minimal') {
        return { success: true, sources, data: base };
      }

      const headerSummary = {
        from: findHeaderValue(headers, 'From'),
        to: findHeaderValue(headers, 'To'),
        cc: findHeaderValue(headers, 'Cc'),
        bcc: findHeaderValue(headers, 'Bcc'),
        subject: findHeaderValue(headers, 'Subject'),
        date: findHeaderValue(headers, 'Date'),
        messageIdHeader: findHeaderValue(headers, 'Message-Id'),
      };

      if (format === 'metadata') {
        return { success: true, sources, data: { ...base, headers: headerSummary } };
      }

      // full
      const { text, html } = extractMessageBody(msg.payload);
      const attachments = collectAttachments(msg.payload);
      return {
        success: true,
        sources,
        data: { ...base, headers: headerSummary, body: { text, html }, attachments },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const modifyLabels = action(
  Type.Object({
    messageId: Type.String({ description: 'The Gmail message ID to modify.' }),
    addLabelIds: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Label IDs to add (e.g. ["STARRED"], ["IMPORTANT"], or a custom label ID from list_labels).',
      }),
    ),
    removeLabelIds: Type.Optional(
      Type.Array(Type.String(), {
        description: 'Label IDs to remove (e.g. ["INBOX"] to archive, ["UNREAD"] to mark as read).',
      }),
    ),
  }),
)({
  id: 'gmail.modify_labels',
  name: 'Modify Labels',
  description:
    'Adds and/or removes labels on a Gmail message. Use this to star (add STARRED), archive (remove INBOX), mark read (remove UNREAD), or apply custom labels. Discover label IDs with list_labels. At least one of addLabelIds or removeLabelIds must be provided.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    // TypeBox has no equivalent to the legacy Zod schema's `.refine(...)`, so
    // the "at least one of addLabelIds/removeLabelIds" constraint that used
    // to live in the schema is re-checked here, verbatim in spirit.
    if (
      !(
        (p.addLabelIds && p.addLabelIds.length > 0) ||
        (p.removeLabelIds && p.removeLabelIds.length > 0)
      )
    ) {
      return { success: false, error: 'Provide at least one of addLabelIds or removeLabelIds.' };
    }
    try {
      const res = await gmailFetch(`/users/me/messages/${p.messageId}/modify`, token, {
        method: 'POST',
        body: JSON.stringify({ addLabelIds: p.addLabelIds, removeLabelIds: p.removeLabelIds }),
      });
      if (!res.ok) return gmailError(res);
      const data = (await res.json()) as GmailMessage;
      return {
        success: true,
        data: {
          id: data.id,
          threadId: data.threadId,
          labelIds: data.labelIds ?? [],
          message: `Labels updated on message ${p.messageId}.`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const trashMessage = action(
  Type.Object({
    messageId: Type.String({ description: 'The Gmail message ID to move to Trash.' }),
  }),
)({
  id: 'gmail.trash_message',
  name: 'Trash Message',
  description:
    'Moves a Gmail message to Trash. This is the same as clicking Delete in the Gmail UI — reversible from the Trash folder for 30 days. Not a permanent delete.',
  riskLevel: 'high',
  execute: async (args, ctx) => {
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const { messageId } = args;
      const res = await gmailFetch(`/users/me/messages/${messageId}/trash`, token, {
        method: 'POST',
      });
      if (!res.ok) return gmailError(res);
      const data = (await res.json()) as GmailMessage;
      return {
        success: true,
        data: {
          id: data.id,
          threadId: data.threadId,
          labelIds: data.labelIds ?? [],
          message: `Message ${messageId} moved to Trash. Recoverable from the Trash folder in the Gmail UI.`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ── Drafts ───────────────────────────────────────────────────────────────

const createDraft = action(
  Type.Object({
    to: Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })], {
      description: 'Recipient email address, or an array of recipient email addresses.',
    }),
    subject: Type.String({ description: 'Email subject line.' }),
    body: Type.String({ description: 'Markdown body of the draft. Gmail receives it as text/plain and rendered text/html MIME alternatives unless bodyHtml is provided.' }),
    bodyHtml: Type.Optional(Type.String({
      minLength: 1,
      pattern: '\\S',
      description: 'Optional HTML body. It must contain non-whitespace content. When provided, it replaces the rendered Markdown HTML alternative.',
    })),
    cc: Type.Optional(Type.Array(Type.String(), { description: 'Optional list of Cc recipients.' })),
    bcc: Type.Optional(Type.Array(Type.String(), { description: 'Optional list of Bcc recipients.' })),
    replyToMessageId: Type.Optional(
      Type.String({
        description: 'Optional Gmail message ID to draft a reply to. The draft is threaded with the original.',
      }),
    ),
    attachments: attachmentsParam('Optional files to attach.'),
  }, { additionalProperties: false }),
)({
  id: 'gmail.create_draft',
  name: 'Create Draft',
  description:
    'Creates a Gmail draft (does NOT send). Gmail sends Markdown body as text/plain and safe rendered HTML unless non-blank bodyHtml overrides the HTML part. Use this for AI-composed emails that the user should review before sending. The draft appears in the Gmail Drafts folder and can be sent later with send_draft, edited with update_draft, given more files with add_draft_attachments, or deleted with delete_draft. Supports file attachments (thread files or working-directory paths) and threading via replyToMessageId.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const files = await resolveAttachments(p.attachments, ctx);
      if (!files.ok) return { success: false, error: files.error };
      const { message, threadId, toList } = await prepareMimeRequest(p, token, files.attachments);
      const res = await submitRawMessage({ path: '/users/me/drafts', method: 'POST', token, message, threadId, draft: true, signal: ctx.signal });
      if (!res.ok) return gmailError(res);
      const data = (await res.json()) as GmailDraft;
      return {
        success: true,
        data: {
          draftId: data.id,
          messageId: data.message?.id,
          threadId: data.message?.threadId,
          to: toList,
          subject: p.subject,
          ...(files.attachments.length > 0 ? { attachments: describeAttachments(files.attachments) } : {}),
          message: `Draft created. Use send_draft with draftId="${data.id}" to send it, or update_draft to edit it first.`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const listDrafts = action(
  Type.Object({
    maxResults: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100,
        default: 25,
        description: 'Maximum number of drafts to return (1-100). Defaults to 25.',
      }),
    ),
    q: Type.Optional(
      Type.String({ description: 'Optional Gmail search query to filter drafts (e.g. "subject:proposal").' }),
    ),
  }),
)({
  id: 'gmail.list_drafts',
  name: 'List Drafts',
  description:
    'Lists Gmail drafts for the authenticated user. Returns draft IDs along with the recipient, subject, snippet, and date for each. Use send_draft, update_draft, or delete_draft to act on a returned draft.',
  riskLevel: 'low',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const qs = new URLSearchParams({ maxResults: String(p.maxResults ?? 25) });
      if (p.q) qs.set('q', p.q);

      const listRes = await gmailFetch(`/users/me/drafts?${qs}`, token);
      if (!listRes.ok) return gmailError(listRes);

      const listData = (await listRes.json()) as {
        drafts?: Array<{ id: string }>;
        resultSizeEstimate?: number;
        nextPageToken?: string;
      };

      const draftRefs = listData.drafts ?? [];
      if (draftRefs.length === 0) {
        return {
          success: true,
          data: { drafts: [], resultSizeEstimate: listData.resultSizeEstimate ?? 0, nextPageToken: null },
        };
      }

      const detailed = await Promise.all(
        draftRefs.map((ref) =>
          gmailFetch(`/users/me/drafts/${ref.id}?format=metadata`, token).then((r) =>
            r.ok ? (r.json() as Promise<GmailDraft>) : null,
          ),
        ),
      );

      const drafts = detailed
        .filter((d): d is GmailDraft => d !== null)
        .map((draft) => {
          const msg = draft.message;
          const headers = msg?.payload?.headers;
          return {
            draftId: draft.id,
            messageId: msg?.id,
            threadId: msg?.threadId,
            snippet: msg?.snippet ?? '',
            to: findHeaderValue(headers, 'To'),
            cc: findHeaderValue(headers, 'Cc'),
            subject: findHeaderValue(headers, 'Subject'),
            date: findHeaderValue(headers, 'Date'),
          };
        });

      return {
        success: true,
        data: {
          drafts,
          resultSizeEstimate: listData.resultSizeEstimate ?? drafts.length,
          nextPageToken: listData.nextPageToken ?? null,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const getDraft = action(
  Type.Object({
    draftId: Type.String({ description: 'The Gmail draft ID, typically from list_drafts results.' }),
  }),
)({
  id: 'gmail.get_draft',
  name: 'Get Draft',
  description: 'Fetches a single Gmail draft by ID with full headers and body. Use list_drafts to discover draft IDs.',
  riskLevel: 'low',
  execute: async (args, ctx) => {
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const { draftId } = args;
      const res = await gmailFetch(`/users/me/drafts/${draftId}?format=full`, token);
      if (!res.ok) return gmailError(res);
      const draft = (await res.json()) as GmailDraft;
      const msg = draft.message;
      const headers = msg?.payload?.headers;
      const { text, html } = extractMessageBody(msg?.payload);
      return {
        success: true,
        data: {
          draftId: draft.id,
          messageId: msg?.id,
          threadId: msg?.threadId,
          labelIds: msg?.labelIds ?? [],
          snippet: msg?.snippet ?? '',
          headers: {
            from: findHeaderValue(headers, 'From'),
            to: findHeaderValue(headers, 'To'),
            cc: findHeaderValue(headers, 'Cc'),
            bcc: findHeaderValue(headers, 'Bcc'),
            subject: findHeaderValue(headers, 'Subject'),
            date: findHeaderValue(headers, 'Date'),
          },
          body: { text, html },
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const updateDraft = action(
  Type.Object({
    draftId: Type.String({ description: 'The Gmail draft ID to update.' }),
    to: Type.Union([Type.String(), Type.Array(Type.String(), { minItems: 1 })], {
      description: 'Recipient email address, or an array of recipient email addresses.',
    }),
    subject: Type.String({ description: 'Email subject line.' }),
    body: Type.String({ description: 'Markdown body of the draft. Gmail receives it as text/plain and rendered text/html MIME alternatives unless bodyHtml is provided.' }),
    bodyHtml: Type.Optional(Type.String({
      minLength: 1,
      pattern: '\\S',
      description: 'Optional HTML body. It must contain non-whitespace content. When provided, it replaces the rendered Markdown HTML alternative.',
    })),
    cc: Type.Optional(Type.Array(Type.String(), { description: 'Optional list of Cc recipients.' })),
    bcc: Type.Optional(Type.Array(Type.String(), { description: 'Optional list of Bcc recipients.' })),
    replyToMessageId: Type.Optional(
      Type.String({ description: 'Optional Gmail message ID to thread the draft with.' }),
    ),
    attachments: attachmentsParam('Optional files to attach. The update replaces all attachments, so list every file the draft should keep.'),
  }, { additionalProperties: false }),
)({
  id: 'gmail.update_draft',
  name: 'Update Draft',
  description:
    'Replaces the contents of an existing Gmail draft. Gmail sends Markdown body as text/plain and safe rendered HTML unless non-blank bodyHtml overrides the HTML part. The new contents fully overwrite the old draft (this is a full replace, not a patch). Use this when iterating on an AI-composed draft before sending.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const files = await resolveAttachments(p.attachments, ctx);
      if (!files.ok) return { success: false, error: files.error };
      const { message, threadId, toList } = await prepareMimeRequest(p, token, files.attachments);
      const res = await submitRawMessage({ path: `/users/me/drafts/${encodeURIComponent(p.draftId)}`, method: 'PUT', token, message, threadId, draft: true, signal: ctx.signal });
      if (!res.ok) return gmailError(res);
      const data = (await res.json()) as GmailDraft;
      return {
        success: true,
        data: {
          draftId: data.id,
          messageId: data.message?.id,
          threadId: data.message?.threadId,
          to: toList,
          subject: p.subject,
          ...(files.attachments.length > 0 ? { attachments: describeAttachments(files.attachments) } : {}),
          message: `Draft ${p.draftId} updated.`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const addDraftAttachments = action(
  Type.Object({
    draftId: Type.String({ description: 'The Gmail draft ID to add files to (from create_draft or list_drafts).' }),
    attachments: attachmentList('Files to add to the draft.'),
  }, { additionalProperties: false }),
)({
  id: 'gmail.add_draft_attachments',
  name: 'Add Draft Attachments',
  description:
    'Adds files to an existing Gmail draft. Keeps the recipients, subject, body, threading, and files the draft already has. Files come from thread files (threadFileId from drive.export_file or file_attach) or working-directory paths. Gmail limits attachments to 25 MB in total.',
  riskLevel: 'medium',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const draftPath = `/users/me/drafts/${encodeURIComponent(p.draftId)}`;
      // format=full reports each existing file's size; format=raw has the bytes to keep.
      const [fullRes, rawRes] = await Promise.all([
        gmailFetch(`${draftPath}?format=full`, token, { signal: ctx.signal }),
        gmailFetch(`${draftPath}?format=raw`, token, { signal: ctx.signal }),
      ]);
      if (!fullRes.ok) return gmailError(fullRes);
      if (!rawRes.ok) return gmailError(rawRes);
      const full = (await fullRes.json()) as GmailDraft;
      const rawDraft = (await rawRes.json()) as GmailDraft;
      const raw = rawDraft.message?.raw;
      if (!raw) {
        return { success: false, error: `Draft ${p.draftId} has no message content. Recreate it with create_draft and attachments.` };
      }
      const files = await resolveAttachments(p.attachments, ctx, attachedBytes(full.message?.payload));
      if (!files.ok) return { success: false, error: files.error };
      const message = appendAttachments(decodeBase64UrlBytes(raw), files.attachments);
      const threadId = rawDraft.message?.threadId ?? full.message?.threadId;
      const res = await submitRawMessage({ path: draftPath, method: 'PUT', token, message, threadId, draft: true, signal: ctx.signal });
      if (!res.ok) return gmailError(res);
      const data = (await res.json()) as GmailDraft;
      return {
        success: true,
        data: {
          draftId: data.id,
          messageId: data.message?.id,
          threadId: data.message?.threadId,
          added: describeAttachments(files.attachments),
          message: `Added ${files.attachments.length} file(s) to draft ${data.id}. Use send_draft to send it.`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const sendDraft = action(
  Type.Object({
    draftId: Type.String({ description: 'The Gmail draft ID to send (from create_draft or list_drafts).' }),
  }),
)({
  id: 'gmail.send_draft',
  name: 'Send Draft',
  description:
    'Sends an existing Gmail draft. After sending, the draft is removed and the message appears in Sent. This is the second half of the compose-review-send flow that pairs with create_draft.',
  riskLevel: 'high',
  execute: async (args, ctx) => {
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const { draftId } = args;
      const res = await gmailFetch('/users/me/drafts/send', token, {
        method: 'POST',
        body: JSON.stringify({ id: draftId }),
      });
      if (!res.ok) return gmailError(res);
      const data = (await res.json()) as GmailMessage;
      return {
        success: true,
        data: {
          draftId,
          messageId: data.id,
          threadId: data.threadId,
          labelIds: data.labelIds ?? [],
          message: `Draft ${draftId} sent. Message ID: ${data.id}.`,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const deleteDraft = action(
  Type.Object({
    draftId: Type.String({ description: 'The Gmail draft ID to delete (from create_draft or list_drafts).' }),
  }),
)({
  id: 'gmail.delete_draft',
  name: 'Delete Draft',
  description:
    'Permanently deletes a Gmail draft. This is irreversible — the draft is removed entirely, not moved to Trash. Use when an AI-composed draft was rejected or replaced.',
  riskLevel: 'high',
  execute: async (args, ctx) => {
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const { draftId } = args;
      const res = await gmailFetch(`/users/me/drafts/${draftId}`, token, { method: 'DELETE' });
      if (!res.ok) return gmailError(res);
      return {
        success: true,
        data: { draftId, message: `Draft ${draftId} permanently deleted.` },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ── Labels + Triage ──────────────────────────────────────────────────────

const listLabels = action(Type.Object({}))({
  id: 'gmail.list_labels',
  name: 'List Labels',
  description:
    'Lists all Gmail labels for the authenticated user, including system labels (INBOX, SENT, STARRED, UNREAD, etc.) and custom user-created labels. Use the returned IDs with modify_labels or list_messages labelIds filter.',
  riskLevel: 'low',
  execute: async (_args, ctx) => {
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const res = await gmailFetch('/users/me/labels', token);
      if (!res.ok) return gmailError(res);
      const data = (await res.json()) as { labels?: GmailLabel[] };
      const labels = (data.labels ?? []).map((label) => ({
        id: label.id,
        name: label.name,
        type: label.type,
        messageListVisibility: label.messageListVisibility,
        labelListVisibility: label.labelListVisibility,
      }));
      return { success: true, data: { labels, count: labels.length } };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

const triageInbox = action(
  Type.Object({
    maxResults: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 50,
        default: 20,
        description: 'How many unread messages to triage in one pass (1-50). Defaults to 20.',
      }),
    ),
    additionalQuery: Type.Optional(
      Type.String({
        description:
          'Optional Gmail query appended to "is:unread", e.g. "newer_than:2d" or "-from:notifications@".',
      }),
    ),
    bodyExcerptLength: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 2000,
        default: 400,
        description: 'Max characters of body text to include per message (0 to skip bodies).',
      }),
    ),
  }),
)({
  id: 'gmail.triage_inbox',
  name: 'Triage Inbox',
  description:
    "Composite action: fetches the user's most recent unread Gmail messages with full content and heuristic categorization in a single call. Returns headers, body excerpts, labels, plus per-message signals (newsletter, meeting reference, contains question, action requested) AND aggregate stats (total unread, top senders, breakdown by category). Designed for AI inbox triage workflows — use the returned data to decide which messages need a reply, can be archived, or warrant a draft response. Pairs naturally with create_draft, modify_labels, and trash_message.",
  riskLevel: 'medium',
  label: () => 'Triaged the Gmail inbox',
  execute: async (args, ctx) => {
    const p = args;
    const token = await getAccessToken(ctx);
    if (!token) return { success: false, error: 'Missing access token' };
    try {
      const queryParts = ['is:unread', p.additionalQuery].filter(Boolean);
      const query = queryParts.join(' ');
      const qs = new URLSearchParams({ maxResults: String(p.maxResults ?? 20), q: query });

      const listRes = await gmailFetch(`/users/me/messages?${qs}`, token);
      if (!listRes.ok) return gmailError(listRes);

      const listData = (await listRes.json()) as {
        messages?: Array<{ id: string }>;
        resultSizeEstimate?: number;
      };

      const totalUnread = listData.resultSizeEstimate ?? 0;
      const messageRefs = listData.messages ?? [];

      if (messageRefs.length === 0) {
        return {
          success: true,
          data: {
            summary: {
              totalUnread,
              fetched: 0,
              topSenders: [],
              newsletterCount: 0,
              meetingReferenceCount: 0,
              questionCount: 0,
              actionRequestedCount: 0,
            },
            messages: [],
          },
        };
      }

      // Use allSettled so a single failed fetch doesn't kill the whole triage
      const settled = await Promise.allSettled(
        messageRefs.map((ref) =>
          gmailFetch(`/users/me/messages/${ref.id}?format=full`, token).then((r) =>
            r.ok ? (r.json() as Promise<GmailMessage>) : Promise.reject(new Error(`${r.status}`)),
          ),
        ),
      );

      const failedFetches = settled.filter((r) => r.status === 'rejected').length;
      const detailed: GmailMessage[] = settled
        .filter((r): r is PromiseFulfilledResult<GmailMessage> => r.status === 'fulfilled')
        .map((r) => r.value);

      const MEETING_PATTERN =
        /\b(meeting|call|invite|invitation|calendar|schedule|reschedul|zoom|google meet|teams)\b/i;
      const QUESTION_PATTERN = /\?/;
      const ACTION_PATTERN =
        /\b(please|could you|can you|let me know|need|review|approve|sign|deadline|by (mon|tue|wed|thu|fri|sat|sun|today|tomorrow|next week|eod|cob))\b/i;
      const excerptLength = p.bodyExcerptLength ?? 400;

      const messages = detailed.map((msg) => {
        const headers = msg.payload?.headers;
        const from = findHeaderValue(headers, 'From');
        const subject = findHeaderValue(headers, 'Subject') ?? '(no subject)';
        const hasUnsubscribe =
          findHeaderValue(headers, 'List-Unsubscribe') !== null ||
          findHeaderValue(headers, 'List-Id') !== null;

        let bodyText = '';
        if (excerptLength > 0) {
          const { text, html } = extractMessageBody(msg.payload);
          bodyText = text || html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>|<[^>]+>/g, ' ');
        }
        const bodyExcerpt = excerptLength > 0 ? truncate(bodyText, excerptLength) : '';
        const searchSurface = `${subject} ${bodyText}`;

        return {
          id: msg.id,
          threadId: msg.threadId,
          from,
          domain: extractDomain(from),
          to: findHeaderValue(headers, 'To'),
          subject,
          date: findHeaderValue(headers, 'Date'),
          snippet: msg.snippet ?? '',
          bodyExcerpt,
          labels: msg.labelIds ?? [],
          isNewsletter: hasUnsubscribe,
          containsMeetingReference: MEETING_PATTERN.test(searchSurface),
          containsQuestion: QUESTION_PATTERN.test(searchSurface),
          actionRequested: ACTION_PATTERN.test(searchSurface),
        };
      });

      const senderCounts = new Map<string, number>();
      for (const m of messages) {
        if (!m.from) continue;
        senderCounts.set(m.from, (senderCounts.get(m.from) ?? 0) + 1);
      }
      const topSenders = [...senderCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([from, count]) => ({ from, count }));

      return {
        success: true,
        data: {
          summary: {
            totalUnread,
            fetched: messages.length,
            failedFetches,
            topSenders,
            newsletterCount: messages.filter((m) => m.isNewsletter).length,
            meetingReferenceCount: messages.filter((m) => m.containsMeetingReference).length,
            questionCount: messages.filter((m) => m.containsQuestion).length,
            actionRequestedCount: messages.filter((m) => m.actionRequested).length,
          },
          messages,
        },
      };
    } catch (error) {
      return { success: false, error: String(error) };
    }
  },
});

// ─── Plugin export ───────────────────────────────────────────────────────────

export const gmailPlugin: ActionPlugin = {
  service: 'gmail',
  description: 'Gmail integration for reading, sending, and triaging email.',
  actions: [
    sendEmail,
    listMessages,
    getMessage,
    modifyLabels,
    trashMessage,
    createDraft,
    listDrafts,
    getDraft,
    updateDraft,
    addDraftAttachments,
    sendDraft,
    deleteDraft,
    listLabels,
    triageInbox,
  ],
};
