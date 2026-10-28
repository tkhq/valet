import type { ActiveViewer } from "@valet/api/wire";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/primitives/avatar";
import { Popover, PopoverContent, PopoverTrigger } from "~/components/primitives/popover";
import { StatusDot } from "~/components/primitives/status-dot";
import { Tooltip } from "~/components/primitives/tooltip";
import { cn } from "~/lib/cn";

/** The people's faces a thread shows: up to three on a desktop, two on a phone. */
const DESKTOP_FACES = 3;
const PHONE_FACES = 2;

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] || name;
}

/** One stable color per person, so a face reads the same in every place. */
function hueOf(userId: string): number {
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

function viewerLabel(viewer: ActiveViewer): string {
  return `${viewer.name}, ${viewer.typing ? "typing" : "here now"}`;
}

/** One line per person for a hover tip: "Dana Sales, typing". */
export function ViewerNames({ viewers }: { viewers: ActiveViewer[] }) {
  return viewers.map((viewer) => <span key={viewer.userId} className="block">{viewerLabel(viewer)}</span>);
}

export function ViewerFace({ viewer, small = false, className }: { viewer: ActiveViewer; small?: boolean; className?: string }) {
  return (
    <span className={cn("relative inline-flex shrink-0", className)}>
      <Avatar size="sm" className={cn("ring-2 ring-paper", small && "h-4 w-4 text-[8px] ring-1")}>
        {viewer.avatarUrl && <AvatarImage src={viewer.avatarUrl} alt="" />}
        <AvatarFallback className="font-semibold text-white" style={{ backgroundColor: `oklch(58% 0.12 ${hueOf(viewer.userId)})` }}>
          {firstName(viewer.name).slice(0, 1).toUpperCase()}
        </AvatarFallback>
      </Avatar>
      {!small && <StatusDot tone="success" size="sm" className="absolute -bottom-0.5 -right-0.5 ring-2 ring-paper" />}
    </span>
  );
}

/** Faces of the other people in the open thread, beside its title. Hover or focus names them; tapping them lists who is here. */
export function ViewerFaces({ viewers }: { viewers: ActiveViewer[] }) {
  if (viewers.length === 0) return null;
  return (
    <Popover>
      <Tooltip content={<ViewerNames viewers={viewers} />}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={`In this thread: ${viewers.map(viewerLabel).join("; ")}`}
            data-testid="thread-viewers"
            className="flex shrink-0 items-center rounded-full p-0.5 max-sm:min-h-11 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-moss/40"
          >
            {viewers.slice(0, DESKTOP_FACES).map((viewer, index) => (
              <ViewerFace key={viewer.userId} viewer={viewer} className={cn(index > 0 && "-ml-1.5", index >= PHONE_FACES && "max-sm:hidden")} />
            ))}
            {viewers.length > PHONE_FACES && <span className="ml-1 text-[11px] text-muted sm:hidden">+{viewers.length - PHONE_FACES}</span>}
            {viewers.length > DESKTOP_FACES && <span className="ml-1 text-[11px] text-muted max-sm:hidden">+{viewers.length - DESKTOP_FACES}</span>}
          </button>
        </PopoverTrigger>
      </Tooltip>
      <PopoverContent className="w-60 p-2">
        <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted">In this thread</p>
        <ul className="space-y-1">
          {viewers.map((viewer) => (
            <li key={viewer.userId} className="flex items-center gap-2 px-1 py-0.5 text-sm">
              <ViewerFace viewer={viewer} />
              <span className="min-w-0 flex-1 truncate">{viewer.name}</span>
              <span className="text-xs text-muted">{viewer.typing ? "typing" : "here now"}</span>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

/** "Dana is typing…" for the other people typing in the open thread. */
export function typingText(viewers: ActiveViewer[]): string {
  const typing = viewers.filter((viewer) => viewer.typing);
  if (typing.length === 0) return "";
  if (typing.length === 1) return `${firstName(typing[0]?.name ?? "")} is typing…`;
  if (typing.length === 2) return `${firstName(typing[0]?.name ?? "")} and ${firstName(typing[1]?.name ?? "")} are typing…`;
  return `${typing.length} people are typing…`;
}

/** The line on top of the composer while someone else types. It stays mounted so screen readers hear it. */
export function TypingLine({ viewers }: { viewers: ActiveViewer[] }) {
  const text = typingText(viewers);
  const first = viewers.find((viewer) => viewer.typing);
  return (
    <div aria-live="polite" data-testid="typing-line" className="mx-auto w-full min-w-0 max-w-[52rem] shrink-0 px-5 sm:px-8">
      {text && first && (
        <p className="flex items-center gap-1.5 pt-2 text-xs text-muted">
          <ViewerFace viewer={first} small />
          {text}
        </p>
      )}
    </div>
  );
}

/** Small faces on a thread row for the other people in that thread. The row's tooltip names them. */
export function RowFaces({ viewers }: { viewers: ActiveViewer[] }) {
  if (viewers.length === 0) return null;
  return (
    <span className="mx-1 inline-flex shrink-0 items-center" role="img" aria-label={`In this thread: ${viewers.map((viewer) => viewer.name).join(", ")}`}>
      {viewers.slice(0, PHONE_FACES).map((viewer, index) => (
        <ViewerFace key={viewer.userId} viewer={viewer} small className={cn(index > 0 && "-ml-1")} />
      ))}
    </span>
  );
}
