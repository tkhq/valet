import { parse, type DefaultTreeAdapterMap } from "parse5";
import { marked } from "marked";
import { ValidationError } from "@valet/shared";
import type { ArtifactSelection } from "../wire/types.js";

type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
const addressableTags = new Set("h1,h2,h3,h4,h5,h6,p,li,table,pre,blockquote,figure,img,svg,canvas,video,section,article,aside,div,button,a".split(","));

function isElement(node: Node): node is Element { return "tagName" in node; }
function textContent(node: Node): string {
  if ("value" in node) return node.value;
  return "childNodes" in node ? node.childNodes.map(textContent).join("") : "";
}
function fnv(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
function normalizedText(text: string): string { return text.replace(/\s+/g, " ").trim(); }

/** Match the preview runtime's DOM-order identifiers, then use parser source locations. */
function selectedElement(content: string, selection: ArtifactSelection): Element {
  if (!selection.vdid) throw new ValidationError("Select an element again, or select its source range.");
  const document = parse(content, { sourceCodeLocationInfo: true });
  const seen = new Map<string, number>();
  const matches: Element[] = [];
  function walk(node: Node, inBody = false): void {
    if (isElement(node)) {
      inBody ||= node.tagName === "body";
      const explicitId = node.attrs.find(attr => attr.name === "data-vdid")?.value;
      if (inBody && (explicitId || (addressableTags.has(node.tagName) &&
          (node.tagName !== "div" || node.childNodes.some(child => "value" in child && /\S/.test(child.value)))))) {
        let id = explicitId;
        if (!id) {
          const tag = node.namespaceURI === "http://www.w3.org/1999/xhtml" ? node.tagName.toUpperCase() : node.tagName;
          const key = `${tag}|${node.attrs.find(attr => attr.name === "role")?.value ?? ""}|${normalizedText(textContent(node)).slice(0, 32)}`;
          const ordinal = seen.get(key) ?? 0;
          seen.set(key, ordinal + 1);
          id = fnv(`${key}|${ordinal}`, 2166136261) + fnv(`${ordinal}|${key}`, 40389);
        }
        if (id === selection.vdid) matches.push(node);
      }
    }
    if ("childNodes" in node) for (const child of node.childNodes) walk(child, inBody);
  }
  walk(document);
  const element = matches.length === 1 ? matches[0] : undefined;
  const location = element?.sourceCodeLocation;
  if (!element || !location || location.endOffset <= location.startOffset) {
    throw new ValidationError("The selected element does not match the source. Refresh the preview, or select its source range.");
  }
  return element;
}

function sourceFallback(): never {
  throw new ValidationError("The selection must match one source text range. Open Source and select the exact range to change.");
}

function uniqueRange(ranges: Array<{ start: number; end: number }>): { start: number; end: number } {
  if (ranges.length !== 1 || !ranges[0]) return sourceFallback();
  return ranges[0];
}

function plainTextRanges(text: string, selected: string, offset: number): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  if (!selected) return ranges;
  for (let start = text.indexOf(selected); start !== -1; start = text.indexOf(selected, start + 1)) {
    ranges.push({ start: offset + start, end: offset + start + selected.length });
  }
  return ranges;
}

/** A preview selection must map to actual text, never attributes, scripts or markup. */
function htmlTextRange(content: string, selection: ArtifactSelection): { start: number; end: number } {
  const root = selection.vdid ? selectedElement(content, selection) : parse(content, { sourceCodeLocationInfo: true });
  const ranges: Array<{ start: number; end: number }> = [];
  function walk(node: Node): void {
    if (isElement(node) && ["script", "style", "template", "noscript"].includes(node.tagName)) return;
    if ("value" in node && node.sourceCodeLocation) {
      const location = node.sourceCodeLocation;
      // Entity decoding and line-ending normalization need an explicit source selection.
      if (content.slice(location.startOffset, location.endOffset) === node.value) {
        ranges.push(...plainTextRanges(node.value, selection.text, location.startOffset));
      }
    }
    if ("childNodes" in node) for (const child of node.childNodes) walk(child);
  }
  walk(root);
  return uniqueRange(ranges);
}

/** Formatted blocks need explicit source offsets until the compiler exposes a source map. */
function markdownTextRange(content: string, selection: ArtifactSelection): { start: number; end: number } {
  const rendered = marked.parse(content, { async: false, gfm: true });
  const anchor = selection.vdid ? selectedElement(rendered, selection) : undefined;
  if (anchor) {
    // A formatted or raw-HTML twin must not redirect this anchor to a later plain block.
    let matches = 0;
    const pending: Node[] = [parse(rendered)];
    while (pending.length) {
      const node = pending.pop();
      if (!node) break;
      if (isElement(node) && node.tagName === anchor.tagName && normalizedText(textContent(node)) === normalizedText(textContent(anchor))) matches++;
      if ("childNodes" in node) pending.push(...node.childNodes);
    }
    if (matches !== 1) return sourceFallback();
  }
  const ranges: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const token of marked.lexer(content, { gfm: true })) {
    const offset = content.indexOf(token.raw, cursor);
    if (offset < 0) return sourceFallback();
    cursor = offset + token.raw.length;
    if ((token.type !== "paragraph" && token.type !== "heading") || typeof token.text !== "string" ||
        !Array.isArray(token.tokens) || token.tokens.some(part => part.type !== "text")) continue;
    const tag = token.type === "heading" ? `h${token.depth}` : "p";
    if (anchor && (anchor.tagName !== tag || normalizedText(textContent(anchor)) !== normalizedText(token.text))) continue;
    const textOffset = token.raw.indexOf(token.text);
    if (textOffset >= 0) ranges.push(...plainTextRanges(token.text, selection.text, offset + textOffset));
  }
  return uniqueRange(ranges);
}

export function resolveArtifactSelection(content: string, format: string, selection: ArtifactSelection): { start: number; end: number; oldText: string } {
  if (!selection || typeof selection.text !== "string" || selection.text.length > 8192 ||
      (selection.kind !== undefined && selection.kind !== "text" && selection.kind !== "element") ||
      (selection.vdid !== undefined && (typeof selection.vdid !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(selection.vdid)))) {
    throw new ValidationError("Select at most 8192 characters, or select a smaller source range.");
  }
  let start: number;
  let end: number;
  if (selection.start !== undefined || selection.end !== undefined) {
    if (!Number.isSafeInteger(selection.start) || !Number.isSafeInteger(selection.end) ||
        selection.start === undefined || selection.end === undefined || selection.start < 0 ||
        selection.end <= selection.start || selection.end > content.length || content.slice(selection.start, selection.end) !== selection.text) {
      throw new ValidationError("The source range does not match the selection. Refresh the source, then select it again.");
    }
    start = selection.start; end = selection.end;
  } else if (selection.kind === "element" && format === "html") {
    const element = selectedElement(content, selection);
    const location = element.sourceCodeLocation;
    if (!location || normalizedText(textContent(element)) !== normalizedText(selection.text)) return sourceFallback();
    start = location.startOffset; end = location.endOffset;
  } else {
    if (selection.kind !== undefined && !selection.vdid) return sourceFallback();
    if (!selection.text) throw new ValidationError("Select the text to change before sending an edit request.");
    ({ start, end } = format === "html" ? htmlTextRange(content, selection) : markdownTextRange(content, selection));
  }
  if (end - start > 65536) throw new ValidationError("The selected element is too large. Select a smaller element or source range.");
  return { start, end, oldText: content.slice(start, end) };
}
