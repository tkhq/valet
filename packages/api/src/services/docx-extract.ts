import { fromBuffer, type Entry, type ZipFile } from "yauzl";
import { SaxesParser } from "saxes";
import type { Readable } from "node:stream";

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;
const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_XML_BYTES = 32 * 1024 * 1024;
const MAX_TEXT_CHARS = 1_000_000;
const WORD_NAMESPACES = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
]);
const PART = /^word\/(document|header\d+|footer\d+|footnotes|endnotes|comments)\.xml$/;

/** Read only Word text parts. Never resolve relationships or external resources. */
export async function extractDocx(data: Uint8Array, signal?: AbortSignal): Promise<{ markdown: string } | null> {
  signal?.throwIfAborted();
  if (data.byteLength > MAX_ARCHIVE_BYTES) throw new Error("DOCX exceeds the 25 MB limit. Share a smaller document.");
  const zip = await new Promise<ZipFile>((resolve, reject) => {
    fromBuffer(Buffer.from(data.buffer, data.byteOffset, data.byteLength), { lazyEntries: true, validateEntrySizes: true }, (error, archive) => {
      if (error || !archive) reject(error ?? new Error("Cannot open DOCX. Export it again."));
      else resolve(archive);
    });
  });
  return new Promise((resolve, reject) => {
    let stream: Readable | undefined;
    let settled = false, entries = 0, totalXml = 0, totalText = 0;
    const parts = new Map<string, string>();
    const seen = new Set<string>();
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      stream?.destroy();
      zip.close();
      if (error) { reject(error); return; }
      if (!parts.has("word/document.xml")) { reject(new Error("DOCX has no word/document.xml. Export it again as DOCX.")); return; }
      const body = parts.get("word/document.xml")!;
      const extra = [...parts].filter(([name, text]) => name !== "word/document.xml" && text).sort(([a], [b]) => a.localeCompare(b));
      const markdown = [body, ...extra.map(([name, text]) => `### ${name.slice(5, -4)}\n\n${text}`)].filter(Boolean).join("\n\n");
      if (markdown.length > MAX_TEXT_CHARS) { reject(new Error("DOCX text exceeds the output limit. Share a smaller document.")); return; }
      resolve(markdown ? { markdown } : null);
    };
    const abort = () => finish(signal?.reason ?? new Error("DOCX extraction aborted."));
    signal?.addEventListener("abort", abort, { once: true });
    zip.on("error", finish);
    zip.on("end", () => finish());
    zip.on("entry", (entry: Entry) => {
      if (settled) return;
      if (++entries > 2048) { finish(new Error("DOCX exceeds the archive entry limit. Share a smaller document.")); return; }
      if (seen.has(entry.fileName)) { finish(new Error("DOCX has duplicate archive entries. Export it again.")); return; }
      seen.add(entry.fileName);
      if (!PART.test(entry.fileName)) { zip.readEntry(); return; }
      totalXml += entry.uncompressedSize;
      if (entry.uncompressedSize > MAX_XML_BYTES || totalXml > MAX_TOTAL_XML_BYTES) {
        finish(new Error("DOCX exceeds the expanded XML limit. Share a smaller document.")); return;
      }
      zip.openReadStream(entry, (error, readable) => {
        if (error || !readable) { finish(error ?? new Error("Cannot read DOCX part. Export it again.")); return; }
        if (settled) { readable.destroy(); return; }
        stream = readable;
        const chunks: Buffer[] = [];
        let size = 0;
        readable.on("error", finish);
        readable.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_XML_BYTES || size > entry.uncompressedSize) {
            finish(new Error("DOCX exceeds the expanded XML limit. Share a smaller document.")); return;
          }
          chunks.push(chunk);
        });
        readable.on("end", () => {
          if (settled) return;
          try {
            const text = extractWordXml(decodeXml(Buffer.concat(chunks)), MAX_TEXT_CHARS - totalText);
            totalText += text.length;
            parts.set(entry.fileName, text);
            stream = undefined;
            zip.readEntry();
          } catch (error) { finish(error); }
        });
      });
    });
    if (signal?.aborted) abort(); else zip.readEntry();
  });
}

function decodeXml(bytes: Buffer): string {
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le"
    : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  return new TextDecoder(utf16, { fatal: true }).decode(bytes);
}

function extractWordXml(xml: string, maxChars: number): string {
  const parser = new SaxesParser({ xmlns: true });
  const output: string[] = [];
  let chars = 0, depth = 0, textDepth = 0, cellDepth = 0, hasImages = false;
  const append = (text: string) => {
    chars += text.length;
    if (chars > maxChars) throw new Error("DOCX text exceeds the output limit. Share a smaller document.");
    output.push(text);
  };
  parser.on("doctype", () => { throw new Error("DOCX contains a prohibited XML doctype. Export it again without custom entities."); });
  parser.on("error", (error) => { throw error; });
  parser.on("opentag", (tag) => {
    if (++depth > 256) throw new Error("DOCX exceeds the XML nesting limit. Export a simpler document.");
    if (depth === 1 && !WORD_NAMESPACES.has(tag.uri)) throw new Error("DOCX has an unsupported XML namespace. Export it again as DOCX.");
    if (!WORD_NAMESPACES.has(tag.uri)) return;
    if (["ins", "del", "delText"].includes(tag.local) || /^move(From|To)/.test(tag.local) || /Change$/.test(tag.local)) {
      throw new Error("DOCX contains tracked revisions. Accept or reject the revisions, then export the document again.");
    }
    if (tag.local === "altChunk" || tag.local === "object") throw new Error("DOCX contains embedded content that cannot be read. Export the complete document as PDF.");
    if (tag.local === "drawing" || tag.local === "pict") hasImages = true;
    if (tag.local === "t") textDepth++;
    if (tag.local === "tc") cellDepth++;
    if (tag.local === "tab") append("\t");
    if (tag.local === "br" || tag.local === "cr") append("\n");
  });
  parser.on("text", (text) => { if (textDepth) append(text); });
  parser.on("cdata", (text) => { if (textDepth) append(text); });
  parser.on("closetag", (tag) => {
    depth--;
    if (!WORD_NAMESPACES.has(tag.uri)) return;
    if (tag.local === "t") textDepth--;
    if (tag.local === "p") append(cellDepth ? "\n" : "\n\n");
    if (tag.local === "tc") { cellDepth--; append("\t"); }
    if (tag.local === "tr") append("\n");
  });
  parser.write(xml).close();
  if (hasImages) append("\n\n[Document contains images or drawings. Their visual content was not extracted.]");
  return output.join("").replace(/\n+\t/g, "\t").replace(/\t\n/g, "\n").trim();
}
