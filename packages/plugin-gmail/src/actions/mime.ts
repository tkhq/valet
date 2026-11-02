import { renderMarkdownToHtml } from './markdown.js';

/** Gmail refuses an email whose attachments total more than 25 MB. */
export const GMAIL_ATTACHMENT_LIMIT_BYTES = 25 * 1024 * 1024;

/** One file to attach, already read into memory. */
export interface MimeAttachment {
  filename: string;
  mimeType: string;
  data: Uint8Array;
}

/**
 * Strip header-injection vectors from a caller-supplied header value: fold
 * CR/LF runs (plus any folding whitespace after them) into a single space
 * and drop the remaining control characters. Without this, a subject or
 * recipient like "Hi\r\nBcc: mole@evil.com" would inject a Bcc header into
 * the raw MIME message.
 */
export function sanitizeHeaderValue(value: string): string {
  return value
    .replace(/[\r\n]+[ \t]*/g, ' ')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

function encodeHeader(value: string): string {
  // RFC 2047 encoded-word for any non-ASCII content in headers.
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

/** Normalize bare LF/CR to CRLF so multipart part bodies stay RFC 5322 clean. */
function toCrlf(value: string): string {
  return value.replace(/\r\n|\r|\n/g, '\r\n');
}

// RFC 2231 attribute-chars: everything else in a parameter value is %-encoded.
const ATTR_CHAR = /^[A-Za-z0-9!#$&+\-.^_`|~]$/;

/**
 * One MIME header parameter on its own folded line. Short printable ASCII
 * stays a quoted string. Anything else (Unicode, long names) is RFC 2231
 * percent-encoded UTF-8, split into numbered sections that keep each line
 * under 78 characters and never split a %XX triplet.
 */
export function headerParam(name: string, value: string): string {
  if (/^[\x20-\x7e]{1,60}$/.test(value)) {
    return `\r\n ${name}="${value.replace(/["\\]/g, '\\$&')}"`;
  }
  const tokens = Array.from(Buffer.from(value, 'utf8'), (byte) => {
    const char = String.fromCharCode(byte);
    return byte < 0x80 && ATTR_CHAR.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  });
  // Room for the folding space, `name*NN*=`, the charset prefix, and `;`.
  const room = 78 - name.length - 22;
  const sections: string[] = [];
  let current = '';
  for (const token of tokens) {
    if (current.length + token.length > room) {
      sections.push(current);
      current = '';
    }
    current += token;
  }
  sections.push(current);
  if (sections.length === 1) return `\r\n ${name}*=UTF-8''${sections[0]}`;
  return sections.map((section, i) => `\r\n ${name}*${i}*=${i === 0 ? "UTF-8''" : ''}${section}`).join(';');
}

const MIME_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/i;

const EXTENSION_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/markdown',
  html: 'text/html',
  json: 'application/json',
  ics: 'text/calendar',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  zip: 'application/zip',
};

/**
 * The Content-Type for an attachment: a well-formed declared type when it
 * is more specific than octet-stream, else a guess from the extension.
 */
export function attachmentMimeType(filename: string, declared?: string): string {
  const type = declared?.split(';', 1)[0].trim().toLowerCase();
  if (type && type !== 'application/octet-stream' && MIME_TYPE.test(type)) return type;
  const ext = /\.([a-z0-9]+)$/i.exec(filename)?.[1]?.toLowerCase();
  return (ext && EXTENSION_TYPES[ext]) || 'application/octet-stream';
}

/** A file name the recipient can see: no control characters or path separators, at most 255 characters. */
export function attachmentFilename(name: string): string {
  const clean = name.replace(/[\x00-\x1f\x7f]/g, '').replace(/[/\\]/g, '_').trim();
  return Array.from(clean || 'attachment').slice(0, 255).join('');
}

/** The refusal for attachments over Gmail's limit, or null when they fit. */
export function attachmentLimitError(totalBytes: number): string | null {
  if (totalBytes <= GMAIL_ATTACHMENT_LIMIT_BYTES) return null;
  const mb = (totalBytes / (1024 * 1024)).toFixed(1);
  return `Attachments total ${mb} MB, over Gmail's 25 MB limit. Share a Google Drive link in the email body instead, or attach fewer or smaller files.`;
}

function attachmentPart(attachment: MimeAttachment): string {
  const filename = attachmentFilename(attachment.filename);
  const mimeType = attachmentMimeType(filename, attachment.mimeType);
  const data = Buffer.from(attachment.data.buffer, attachment.data.byteOffset, attachment.data.byteLength).toString('base64');
  const lines: string[] = [];
  // RFC 2045 caps base64 lines at 76 characters.
  for (let i = 0; i < data.length; i += 76) lines.push(data.slice(i, i + 76));
  return [
    `Content-Type: ${mimeType};${headerParam('name', filename)}`,
    `Content-Disposition: attachment;${headerParam('filename', filename)}`,
    'Content-Transfer-Encoding: base64',
    '',
    lines.join('\r\n'),
  ].join('\r\n');
}

function boundary(kind: string): string {
  return `valet-${kind}-${crypto.randomUUID()}`;
}

/**
 * Build an RFC 5322 message. The body is multipart/alternative (Markdown
 * source as text/plain, rendered or explicit HTML as text/html). With
 * attachments, that part becomes the first part of a multipart/mixed body.
 */
export function buildMimeMessage(opts: {
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  bodyHtml?: string;
  inReplyTo?: string | null;
  references?: string | null;
  attachments?: MimeAttachment[];
}): string {
  const addressList = (addresses: string[]) =>
    addresses.map(sanitizeHeaderValue).join(', ');
  const lines: string[] = [];
  lines.push(`To: ${addressList(opts.to)}`);
  if (opts.cc && opts.cc.length > 0) lines.push(`Cc: ${addressList(opts.cc)}`);
  if (opts.bcc && opts.bcc.length > 0) lines.push(`Bcc: ${addressList(opts.bcc)}`);
  lines.push(`Subject: ${encodeHeader(sanitizeHeaderValue(opts.subject))}`);
  lines.push('MIME-Version: 1.0');

  // An explicit non-blank bodyHtml overrides Markdown rendering. The schemas
  // reject blank bodyHtml, but preserve the safe Markdown path if a caller
  // bypasses validation.
  const bodyHtml = opts.bodyHtml?.trim() ? opts.bodyHtml : renderMarkdownToHtml(opts.body);
  const alternative = boundary('alt');
  const alternativeType = `Content-Type: multipart/alternative; boundary="${alternative}"`;
  const alternativeBody = [
    `--${alternative}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    toCrlf(opts.body),
    `--${alternative}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    toCrlf(bodyHtml),
    `--${alternative}--`,
  ];
  const attachments = opts.attachments ?? [];
  const mixed = attachments.length > 0 ? boundary('mixed') : null;
  lines.push(mixed ? `Content-Type: multipart/mixed; boundary="${mixed}"` : alternativeType);
  if (opts.inReplyTo) lines.push(`In-Reply-To: ${sanitizeHeaderValue(opts.inReplyTo)}`);
  if (opts.references) lines.push(`References: ${sanitizeHeaderValue(opts.references)}`);
  lines.push('');
  if (!mixed) {
    lines.push(...alternativeBody);
    return lines.join('\r\n');
  }
  lines.push(`--${mixed}`, alternativeType, '', ...alternativeBody);
  for (const attachment of attachments) lines.push(`--${mixed}`, attachmentPart(attachment));
  lines.push(`--${mixed}--`);
  return lines.join('\r\n');
}

interface HeaderField {
  name: string;
  lines: string;
  value: string;
}

/** Split a header block into fields, keeping each field's original (folded) lines. */
function parseHeaderFields(block: string): HeaderField[] {
  const fields: HeaderField[] = [];
  for (const line of block.split(/\r?\n/)) {
    const last = fields.at(-1);
    if (last && /^[ \t]/.test(line)) {
      last.lines += `\r\n${line}`;
      last.value += line;
      continue;
    }
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    fields.push({ name: line.slice(0, colon).trim().toLowerCase(), lines: line, value: line.slice(colon + 1) });
  }
  return fields;
}

/**
 * Add attachment parts to an existing raw message and keep every byte of
 * its other parts. A multipart/mixed message gets the new parts before its
 * closing delimiter. Any other message becomes the first part of a new
 * multipart/mixed body. The message is handled as latin1 so non-UTF-8
 * bytes in the existing parts survive unchanged.
 */
export function appendAttachments(raw: Uint8Array, attachments: MimeAttachment[]): Uint8Array {
  const text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('latin1');
  const separator = /\r?\n\r?\n/.exec(text);
  const headerBlock = separator ? text.slice(0, separator.index) : text;
  const body = separator ? text.slice(separator.index + separator[0].length) : '';
  const fields = parseHeaderFields(headerBlock);
  const parts = attachments.map(attachmentPart);

  const contentType = fields.find((field) => field.name === 'content-type')?.value ?? '';
  const mediaType = contentType.split(';', 1)[0].trim().toLowerCase();
  const existingBoundary = /boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  const mixed = existingBoundary?.[1] ?? existingBoundary?.[2];
  if (mediaType === 'multipart/mixed' && mixed) {
    const close = body.lastIndexOf(`--${mixed}--`);
    if (close === 0 || (close > 0 && body[close - 1] === '\n')) {
      const added = parts.map((part) => `--${mixed}\r\n${part}\r\n`).join('');
      return Buffer.from(`${headerBlock}\r\n\r\n${body.slice(0, close)}${added}${body.slice(close)}`, 'latin1');
    }
  }

  const wrapper = boundary('mixed');
  const isContent = (field: HeaderField) => field.name.startsWith('content-');
  const kept = fields.filter((field) => !isContent(field) && field.name !== 'mime-version').map((field) => field.lines);
  const contentLines = fields.filter(isContent).map((field) => field.lines);
  const headers = [...kept, 'MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${wrapper}"`].join('\r\n');
  const firstPart = `--${wrapper}\r\n${contentLines.join('\r\n')}${contentLines.length > 0 ? '\r\n' : ''}\r\n${body}\r\n`;
  const added = parts.map((part) => `--${wrapper}\r\n${part}\r\n`).join('');
  return Buffer.from(`${headers}\r\n\r\n${firstPart}${added}--${wrapper}--\r\n`, 'latin1');
}
