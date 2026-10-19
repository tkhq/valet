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

/** The pull on glued punctuation: half the token's padding (`TOKEN_PAD_X`), in
 * em, so at every size the mark sits at the pill's edge, not inside its tint
 * and not a full padding away from it. */
export const GLUE_PULL = "-ml-[0.2em]";

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

/** One part. `readAs` is what a screen reader reads for a token (`Ref`'s `readAs`). */
export function SentencePartView({ part, links = true, readAs }: { part: SentencePart; links?: boolean; readAs?: string }) {
  switch (part.kind) {
    case "text":
      return <>{part.text}</>;
    case "place":
      return links
        ? <Ref kind="place" service={part.service} text={part.text} readAs={readAs} to="/presence/places/$subject" params={{ subject: part.subject }} />
        : <Ref kind="place" service={part.service} text={part.text} readAs={readAs} />;
    case "thread":
      return links && part.threadId !== undefined
        ? <Ref kind="thread" text={part.text} readAs={readAs} to="/threads/$threadId" params={{ threadId: part.threadId }} />
        : <Ref kind="thread" text={part.text} readAs={readAs} />;
    case "workflow":
      return links
        ? <Ref kind="workflow" text={part.text} readAs={readAs} to="/workflows/$workflowId" params={{ workflowId: part.id }} />
        : <Ref kind="workflow" text={part.text} readAs={readAs} />;
    case "person":
      return <Ref kind="person" text={part.text} readAs={readAs} />;
  }
}

/** Punctuation that closes up to the token before it: `acme/web,` and not `acme/web ,`. */
const CLOSING = /^[,.:;!?)]+/;

/**
 * A sentence of parts. A text part that starts with punctuation after a
 * token has its punctuation glued to the token: no whitespace between the
 * two, one unbreakable span, and the punctuation pulled back by the token's
 * right padding, so a line never starts with a comma. The sentence's
 * accessible name reads the punctuation with no space before it: the
 * visible token text and punctuation are hidden from screen readers, and
 * a visually hidden span inside the token reads the two as one (`Ref`'s
 * `readAs`). A linked token takes that text as its name; no generic
 * element has one.
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
                // The accessible name reads every element apart from its
                // neighbors, so the punctuation would read after a space
                // ("as Ops Bot ."). The token reads its text and its
                // punctuation joined, as `partsText` does, and the visible
                // punctuation is hidden from screen readers.
                <span data-glued="" className="whitespace-nowrap">
                  <SentencePartView part={part} links={links} readAs={`${part.text}${glued}`} />
                  <span data-glue="" aria-hidden="true" className={GLUE_PULL}>{glued}</span>
                </span>
              )
              : <SentencePartView part={part} links={links} />}
          </Fragment>
        );
      })}
    </>
  );
}
