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

/** Punctuation that closes up to the token before it: `acme/web,` and not `acme/web ,`. */
const CLOSING = /^[,.:;!?)]+/;

/**
 * A sentence of parts. A text part that starts with punctuation after a
 * token has its punctuation glued to the token: no whitespace between the
 * two, one unbreakable span, and the punctuation tucked against the token's
 * padding, so a line never starts with a comma.
 */
export function Sentence({ parts, links = true }: { parts: readonly SentencePart[]; links?: boolean }) {
  const keys = partKeys(parts);
  return (
    <>
      {parts.map((part, i) => {
        const prev = parts[i - 1];
        const next = parts[i + 1];
        // The punctuation a token takes from the text after it.
        const glued = part.kind !== "text" && next?.kind === "text" ? CLOSING.exec(next.text)?.[0] : undefined;
        if (part.kind === "text" && prev !== undefined && prev.kind !== "text") {
          const taken = CLOSING.exec(part.text)?.[0];
          if (taken !== undefined) {
            const rest = part.text.slice(taken.length);
            return rest.length > 0 ? <Fragment key={keys[i]}>{rest}</Fragment> : null;
          }
        }
        return (
          <Fragment key={keys[i]}>
            {glued !== undefined
              ? (
                <span data-glued="" className="whitespace-nowrap">
                  <SentencePartView part={part} links={links} />
                  <span className="-ml-0.5">{glued}</span>
                </span>
              )
              : <SentencePartView part={part} links={links} />}
          </Fragment>
        );
      })}
    </>
  );
}
