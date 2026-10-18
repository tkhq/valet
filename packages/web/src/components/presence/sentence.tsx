/**
 * A sentence of Presence, as text with reference tokens: each place, thread,
 * workflow, and person the sentence names renders as a `Ref`. A place links
 * to its place page, a thread to its thread page when the sentence knows its
 * id, and a workflow to its editor. A person has no page.
 *
 * `links={false}` renders the tokens without links, for a sentence inside a
 * dialog that is still collecting input: a link there would close the
 * dialog and drop the reader's choices.
 */
import { Fragment } from "react";
import { Ref } from "./ref";
import type { SentencePart } from "./sentences";

/**
 * Stable keys for parts, which have no ids: a part's kind and text, and a
 * count for a part that repeats (two `, ` texts), never the array position.
 */
function partKeys(parts: readonly SentencePart[]): string[] {
  const seen = new Map<string, number>();
  return parts.map((part) => {
    const base = `${part.kind}:${part.text}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}#${n}`;
  });
}

export function SentencePartView({ part, links = true }: { part: SentencePart; links?: boolean }) {
  switch (part.kind) {
    case "text":
      return <>{part.text}</>;
    case "place":
      return links
        ? <Ref kind="place" service={part.service} text={part.text} to="/presence/places/$subject" params={{ subject: part.subject }} />
        : <Ref kind="place" service={part.service} text={part.text} />;
    case "thread":
      return links && part.threadId !== undefined
        ? <Ref kind="thread" text={part.text} to="/threads/$threadId" params={{ threadId: part.threadId }} />
        : <Ref kind="thread" text={part.text} />;
    case "workflow":
      return links
        ? <Ref kind="workflow" text={part.text} to="/workflows/$workflowId" params={{ workflowId: part.id }} />
        : <Ref kind="workflow" text={part.text} />;
    case "person":
      return <Ref kind="person" text={part.text} />;
  }
}

export function Sentence({ parts, links = true }: { parts: readonly SentencePart[]; links?: boolean }) {
  const keys = partKeys(parts);
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={keys[i]}>
          <SentencePartView part={part} links={links} />
        </Fragment>
      ))}
    </>
  );
}
