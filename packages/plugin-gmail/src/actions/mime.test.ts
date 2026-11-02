import { describe, it, expect } from 'vitest';
import {
  GMAIL_ATTACHMENT_LIMIT_BYTES,
  appendAttachments,
  attachmentFilename,
  attachmentLimitError,
  attachmentMimeType,
  buildMimeMessage,
  headerParam,
  type MimeAttachment,
} from './mime.js';

const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, 0xff, 0x00, 0x80]);

function message(attachments: MimeAttachment[] = []): string {
  return buildMimeMessage({ to: ['client@example.com'], subject: 'Contract', body: 'Hi,\nattached.', attachments });
}

function boundaryOf(headers: string): string {
  const match = /boundary="([^"]+)"/.exec(headers);
  if (!match) throw new Error('Expected a boundary.');
  return match[1];
}

/** The parts between `--boundary` delimiters, without the preamble or epilogue. */
function parts(body: string, boundary: string): string[] {
  const close = body.indexOf(`\r\n--${boundary}--`);
  const inner = body.slice(0, close);
  return inner.split(`--${boundary}\r\n`).slice(1).map((part) => part.replace(/\r\n$/, ''));
}

function splitHead(text: string): { head: string; body: string } {
  const at = text.indexOf('\r\n\r\n');
  return { head: text.slice(0, at), body: text.slice(at + 4) };
}

/** Undo RFC 2231 encoding (single or numbered sections) for one parameter. */
function decodeParam(head: string, name: string): string {
  const unfolded = head.replace(/\r\n[ \t]/g, ' ');
  const quoted = new RegExp(`(?<![\\w])${name}="((?:[^"\\\\]|\\\\.)*)"`).exec(unfolded);
  if (quoted) return quoted[1].replace(/\\(.)/g, '$1');
  const sections = [...unfolded.matchAll(new RegExp(`(?<![\\w])${name}\\*(?:(\\d+)\\*)?=([^;\\s]+)`, 'g'))]
    .sort((a, b) => Number(a[1] ?? 0) - Number(b[1] ?? 0))
    .map((m) => m[2]);
  if (sections.length === 0) throw new Error(`Missing ${name} parameter.`);
  return decodeURIComponent(sections.join('').replace(/^UTF-8''/, ''));
}

function attachmentData(part: string): Uint8Array {
  return new Uint8Array(Buffer.from(splitHead(part).body.replace(/\r\n/g, ''), 'base64'));
}

describe('buildMimeMessage with attachments', () => {
  it('keeps the plain multipart/alternative shape without attachments', () => {
    const { head } = splitHead(message());
    expect(head).toMatch(/Content-Type: multipart\/alternative; boundary="valet-alt-/);
    expect(head).not.toContain('multipart/mixed');
  });

  it('wraps the body and each file in multipart/mixed with exact bytes', () => {
    const csv = new TextEncoder().encode('a,b\n1,2\n');
    const text = message([
      { filename: 'SOW.pdf', mimeType: 'application/pdf', data: pdf },
      { filename: 'rates.csv', mimeType: 'text/csv', data: csv },
    ]);
    const { head, body } = splitHead(text);
    expect(head).toContain('To: client@example.com');
    expect(head).toMatch(/Content-Type: multipart\/mixed; boundary="valet-mixed-/);
    const sections = parts(body, boundaryOf(head));
    expect(sections).toHaveLength(3);
    expect(sections[0]).toMatch(/^Content-Type: multipart\/alternative; boundary="valet-alt-/);
    expect(sections[0]).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(sections[0]).toContain('Hi,\r\nattached.');
    expect(sections[1]).toContain('Content-Type: application/pdf;\r\n name="SOW.pdf"');
    expect(sections[1]).toContain('Content-Disposition: attachment;\r\n filename="SOW.pdf"');
    expect(sections[1]).toContain('Content-Transfer-Encoding: base64');
    expect(attachmentData(sections[1])).toEqual(pdf);
    expect(sections[2]).toContain('Content-Type: text/csv;');
    expect(attachmentData(sections[2])).toEqual(csv);
  });

  it('wraps base64 bodies at 76 characters', () => {
    const big = new Uint8Array(10_000).map((_, i) => i % 256);
    const { head, body } = splitHead(message([{ filename: 'big.bin', mimeType: 'application/octet-stream', data: big }]));
    const file = parts(body, boundaryOf(head))[1];
    const lines = splitHead(file).body.split('\r\n');
    expect(Math.max(...lines.map((line) => line.length))).toBe(76);
    expect(attachmentData(file)).toEqual(big);
  });

  it('encodes a Unicode filename with RFC 2231 and round-trips it', () => {
    const name = 'Résumé 履歴.pdf';
    const { head, body } = splitHead(message([{ filename: name, mimeType: 'application/pdf', data: pdf }]));
    const file = splitHead(parts(body, boundaryOf(head))[1]).head;
    expect(file).toContain("filename*=UTF-8''R%C3%A9sum%C3%A9%20%E5%B1%A5%E6%AD%B4.pdf");
    expect(file).not.toMatch(/[^\x00-\x7f]/);
    expect(decodeParam(file, 'filename')).toBe(name);
    expect(decodeParam(file, 'name')).toBe(name);
  });

  it('splits a long filename into numbered sections with short lines', () => {
    const name = `${'Statement of Work – Phase Two – '.repeat(4)}最終版.pdf`;
    const { head, body } = splitHead(message([{ filename: name, mimeType: 'application/pdf', data: pdf }]));
    const file = splitHead(parts(body, boundaryOf(head))[1]).head;
    expect(file).toContain("filename*0*=UTF-8''");
    expect(file).toContain('filename*1*=');
    expect(Math.max(...file.split('\r\n').map((line) => line.length))).toBeLessThanOrEqual(78);
    expect(decodeParam(file, 'filename')).toBe(name);
  });

  it('escapes quotes and cannot inject headers through a filename', () => {
    expect(headerParam('filename', 'my "final" \\ copy.pdf')).toBe('\r\n filename="my \\"final\\" \\\\ copy.pdf"');
    const text = message([{ filename: 'a.pdf\r\nBcc: mole@evil.example', mimeType: 'application/pdf', data: pdf }]);
    expect(text).not.toMatch(/^Bcc:/m);
  });
});

describe('attachment helpers', () => {
  it('cleans file names', () => {
    expect(attachmentFilename('../reports/q3.pdf')).toBe('.._reports_q3.pdf');
    expect(attachmentFilename('\x00\r\n')).toBe('attachment');
    expect(Array.from(attachmentFilename('é'.repeat(300)))).toHaveLength(255);
  });

  it('prefers a specific declared type and guesses from the extension otherwise', () => {
    expect(attachmentMimeType('a.bin', 'Application/PDF; charset=binary')).toBe('application/pdf');
    expect(attachmentMimeType('SOW.PDF', 'application/octet-stream')).toBe('application/pdf');
    expect(attachmentMimeType('deck.pptx')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
    expect(attachmentMimeType('x.pdf', 'text/html\r\nX-Evil: 1')).toBe('application/pdf');
    expect(attachmentMimeType('archive.unknown')).toBe('application/octet-stream');
  });

  it("refuses attachments over Gmail's 25 MB limit and names the fix", () => {
    expect(attachmentLimitError(GMAIL_ATTACHMENT_LIMIT_BYTES)).toBeNull();
    const error = attachmentLimitError(GMAIL_ATTACHMENT_LIMIT_BYTES + 1);
    expect(error).toContain("over Gmail's 25 MB limit");
    expect(error).toContain('Share a Google Drive link');
  });
});

describe('appendAttachments', () => {
  const extra: MimeAttachment = { filename: 'Agreement.pdf', mimeType: 'application/pdf', data: pdf };

  it('adds a part before the closing delimiter of a multipart/mixed message', () => {
    const original = message([{ filename: 'SOW.pdf', mimeType: 'application/pdf', data: pdf }]);
    const updated = Buffer.from(appendAttachments(Buffer.from(original, 'utf8'), [extra])).toString('utf8');
    const { head, body } = splitHead(updated);
    const boundary = boundaryOf(head);
    const close = original.lastIndexOf(`--${boundary}--`);
    expect(updated.startsWith(original.slice(0, close))).toBe(true);
    const sections = parts(body, boundary);
    expect(sections).toHaveLength(3);
    expect(decodeParam(splitHead(sections[2]).head, 'filename')).toBe('Agreement.pdf');
    expect(attachmentData(sections[2])).toEqual(pdf);
  });

  it('wraps a message without attachments and keeps its headers and body', () => {
    const original = message();
    const updated = Buffer.from(appendAttachments(Buffer.from(original, 'utf8'), [extra])).toString('utf8');
    const { head, body } = splitHead(updated);
    expect(head).toContain('To: client@example.com');
    expect(head).toContain('Subject: Contract');
    expect(head.match(/MIME-Version/g)).toHaveLength(1);
    expect(head).toMatch(/Content-Type: multipart\/mixed; boundary="valet-mixed-/);
    const sections = parts(body, boundaryOf(head));
    expect(sections).toHaveLength(2);
    const originalHead = splitHead(original);
    expect(sections[0]).toBe(`${/Content-Type: multipart\/alternative[^\r]*/.exec(originalHead.head)?.[0]}\r\n\r\n${originalHead.body}`);
    expect(attachmentData(sections[1])).toEqual(pdf);
  });

  it('keeps non-UTF-8 bytes and LF-only messages intact', () => {
    const latin1 = Buffer.from('To: a@example.com\nSubject: Caf\xe9\nContent-Type: text/plain; charset=ISO-8859-1\n\nCaf\xe9 au lait\n', 'latin1');
    const updated = Buffer.from(appendAttachments(new Uint8Array(latin1), [extra]));
    expect(updated.includes(Buffer.from('Caf\xe9 au lait', 'latin1'))).toBe(true);
    const text = updated.toString('latin1');
    expect(text).toContain('Content-Type: text/plain; charset=ISO-8859-1\r\n\r\nCaf\xe9 au lait');
    expect(text).toMatch(/\r\n--valet-mixed-[^-]+-[^\r]*--\r\n$/);
  });
});
