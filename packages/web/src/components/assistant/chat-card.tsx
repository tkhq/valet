import { useState } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Send } from "lucide-react";
import type { Message } from "@valet/api/wire";
import { Button, Spinner, Textarea } from "~/components/primitives";
import { useOrchestratorInfo } from "~/api/orchestrator";
import { useMessages, useSendPrompt } from "~/api/queries";
import { useSessionStream } from "~/stores/stream";

const RECENT_LIMIT = 6;

/** Pure so the "last ~6" slicing is testable without a query/store. */
export function recentMessages(messages: Message[], limit = RECENT_LIMIT): Message[] {
  return messages.slice(-limit);
}

/**
 * Dashboard chat card (decision 15): last ~6 messages of the assistant's
 * default thread, live via the stream store when it already has this
 * session's messages (e.g. the chat page is/was open in this tab), else a
 * plain REST snapshot — self-contained, owns its own query, degrades on
 * its own (never blanks the dashboard).
 */
export function ChatCard() {
  const info = useOrchestratorInfo();
  const sessionId = info.data?.sessionId;
  const name = info.data?.name ?? "your assistant";

  // `useMessages` disables itself internally when `id` is falsy — no need
  // to pass `enabled` here.
  const messagesQ = useMessages(sessionId ?? "");
  const stream = useSessionStream(sessionId ?? "__none__");
  const live = stream.messages.length > 0;
  const messages = recentMessages(live ? stream.messages : (messagesQ.data?.messages ?? []));

  const [text, setText] = useState("");
  const [sendError, setSendError] = useState(false);
  const send = useSendPrompt(sessionId ?? "");
  const navigate = useNavigate();

  async function submit() {
    const t = text.trim();
    if (!t || !sessionId || send.isPending) return;
    setText("");
    setSendError(false);
    try {
      await send.mutateAsync({ text: t });
      navigate({ to: "/chat" });
    } catch (err) {
      setText(t);
      setSendError(true);
      console.error("failed to send:", err);
    }
  }

  return (
    <section className="rounded-lg border border-line bg-paper flex flex-col min-h-0">
      <header className="px-4 py-3 border-b border-line flex items-center justify-between">
        <h2 className="font-display text-base text-ink">
          <Link to="/chat" className="hover:text-moss">
            Chat
          </Link>
        </h2>
        <Link to="/chat" className="text-xs text-muted hover:text-moss">
          Open
        </Link>
      </header>

      <div className="flex-1 px-4 py-3 space-y-2 overflow-y-auto max-h-64">
        {!live && messagesQ.isLoading && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Spinner size={14} /> Loading…
          </div>
        )}
        {!live && messagesQ.error && (
          <div className="text-xs text-danger-500">
            Couldn't load recent messages.{" "}
            <button type="button" className="underline" onClick={() => messagesQ.refetch()}>
              Retry
            </button>
          </div>
        )}
        {messages.length === 0 && !messagesQ.isLoading && !messagesQ.error && (
          <p className="text-sm text-muted">Say hello — {name} remembers what matters.</p>
        )}
        {messages.map((m) => (
          <div key={m.id} className="text-sm">
            <span className="mr-1.5 text-xs font-medium text-muted">
              {m.role === "user" ? "you" : name.toLowerCase()}
            </span>
            <span className="text-ink">{m.content.slice(0, 240) || "…"}</span>
          </div>
        ))}
      </div>

      {sendError && (
        <div className="px-4 pt-2 text-xs text-danger-500">
          Couldn't send that message.{" "}
          <button type="button" className="underline" onClick={() => void submit()}>
            Retry
          </button>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="border-t border-line p-3 flex gap-2 items-end"
      >
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          rows={1}
          placeholder={sessionId ? `Send a message to ${name}` : "Loading…"}
          className="flex-1"
          disabled={!sessionId || send.isPending}
        />
        <Button
          type="submit"
          size="md"
          disabled={!sessionId || send.isPending || text.trim().length === 0}
        >
          <Send className="h-4 w-4" />
        </Button>
      </form>
    </section>
  );
}
