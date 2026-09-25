import { useEffect, useRef, useState } from "react";
import {
  BROWSER_AGENT_CURSOR_LIFETIME_MS,
  type BrowserAgentCursor,
} from "@valet/shared";
import type { BrowserFrame } from "~/api/browser";
import { cn } from "~/lib/cn";

function frameIdentity(frame: BrowserFrame) {
  return `${frame.runtimeId}:${frame.tabId}:${frame.documentId}:${frame.viewport.width}:${frame.viewport.height}`;
}

/** Keep visual activity attached to the image that has finished decoding. */
export function BrowserPageImage({ frame, alt, onLoad, onError, suppressedSequence, showAgentCursor = true }: {
  frame: BrowserFrame;
  alt: string;
  onLoad?: () => void;
  onError?: () => void;
  suppressedSequence?: number;
  showAgentCursor?: boolean;
}) {
  const [decoded, setDecoded] = useState<BrowserFrame | null>(null);
  const [privateSequence, setPrivateSequence] = useState(-1);
  useEffect(() => {
    if (!showAgentCursor)
      setPrivateSequence((sequence) => Math.max(sequence, frame.agentCursor?.sequence ?? -1));
  }, [showAgentCursor, frame.agentCursor?.sequence]);
  const identity = frameIdentity(frame);
  const cursor = showAgentCursor && decoded && frameIdentity(decoded) === identity && frame.agentCursor &&
    decoded.agentCursor && decoded.agentCursor.sequence > Math.max(suppressedSequence ?? -1, privateSequence)
    ? decoded.agentCursor : undefined;
  return <>
    <img
      key={`image:${identity}`}
      src={frame.url}
      alt={alt}
      draggable={false}
      className="absolute inset-0 h-full w-full select-none object-contain"
      onLoad={() => {
        const ageMs = (frame.agentCursor?.ageMs ?? 0) + Math.max(0, Date.now() - (frame.receivedAt ?? Date.now()));
        setDecoded({ ...frame, agentCursor: frame.agentCursor && ageMs < BROWSER_AGENT_CURSOR_LIFETIME_MS ? { ...frame.agentCursor, ageMs } : undefined });
        onLoad?.();
      }}
      onError={() => { setDecoded(null); onError?.(); }}
    />
    <BrowserAgentPointer key={`pointer:${identity}`} cursor={cursor} viewport={frame.viewport} />
  </>;
}

function BrowserAgentPointer({ cursor, viewport }: {
  cursor?: BrowserAgentCursor;
  viewport: { width: number; height: number };
}) {
  const layer = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [lastCursor, setLastCursor] = useState(cursor);
  const expiry = useRef({ sequence: -1, at: 0 });
  const [expired, setExpired] = useState<number | null>(null);
  const sequence = cursor?.sequence;
  const ageMs = cursor?.ageMs ?? 0;
  useEffect(() => { if (cursor) setLastCursor(cursor); }, [cursor]);
  useEffect(() => {
    const element = layer.current;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      setSize({ width, height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (sequence === undefined) return;
    if (expiry.current.sequence !== sequence) {
      expiry.current = { sequence, at: Date.now() + Math.max(0, BROWSER_AGENT_CURSOR_LIFETIME_MS - ageMs) };
    }
    const timer = setTimeout(() => setExpired(sequence), Math.max(0, expiry.current.at - Date.now()));
    return () => clearTimeout(timer);
  }, [sequence, ageMs]);

  const scale = Math.min(size.width / viewport.width, size.height / viewport.height);
  const x = lastCursor ? (size.width - viewport.width * scale) / 2 + lastCursor.x * scale : 0;
  const y = lastCursor ? (size.height - viewport.height * scale) / 2 + lastCursor.y * scale : 0;
  return <div ref={layer} aria-hidden="true" className="pointer-events-none absolute inset-0 overflow-hidden">
    {lastCursor && scale > 0 && <div
      data-agent-pointer={lastCursor.kind}
      className="absolute left-0 top-0 h-0 w-0 transition-[transform,opacity] duration-200 ease-out motion-reduce:transition-none"
      style={{ transform: `translate3d(${x}px, ${y}px, 0)`, opacity: !cursor || expired === sequence ? 0 : 1 }}
    >
      <span key={lastCursor.sequence} data-agent-pulse={lastCursor.kind} className={cn(
        "absolute -left-3 -top-3 h-6 w-6 rounded-full bg-moss-wash-strong opacity-0 motion-reduce:animate-none",
        lastCursor.kind === "click" && "animate-browser-agent-click border-2 border-accent-300 motion-reduce:opacity-50",
        lastCursor.kind === "type" && "animate-browser-agent-type motion-reduce:opacity-50",
      )} />
      <svg className="absolute -left-0.5 -top-0.5 max-w-none text-accent-300 drop-shadow-[0_0_5px_currentColor]" width="26" height="32" viewBox="0 0 26 32" fill="none">
        <path d="M2 2L22 18L13.5 19.2L9 27L2 2Z" className="fill-neutral-800 stroke-white" strokeWidth="1.8" strokeLinejoin="round" />
      </svg>
    </div>}
  </div>;
}
