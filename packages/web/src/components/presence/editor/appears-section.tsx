/**
 * The editor's **Appears as** section (docs/specs/2026-10-16-presence-hub-design.md
 * Part H step 6): the display name and avatar URL, with a live chip of how
 * a reply will look. The fields are the shared appearance inputs.
 */
import type { Appearance } from "@valet/shared";
import { Avatar, AvatarFallback, AvatarImage } from "~/components/primitives";
import { AppearanceSettings } from "../appearance-settings";

/** The section's summary, and whether it reads the default. */
export function appearsSummary(value: Appearance): { text: string; muted: boolean } {
  const name = value.displayName?.trim();
  if (name) return { text: name, muted: false };
  if (value.avatarUrl?.trim()) return { text: "Valet, with your avatar", muted: false };
  return { text: "Valet, the workspace's name and avatar", muted: true };
}

export function AppearsSection({ value, onChange, workflow = false }: {
  value: Appearance;
  onChange: (value: Appearance) => void;
  /** True for a line that runs a workflow: these fields override the workflow's. */
  workflow?: boolean;
}) {
  const name = value.displayName?.trim() || "Valet";
  const avatar = value.avatarUrl?.trim();
  return (
    <>
      <div data-testid="appears-chip" className="inline-flex items-center gap-2 justify-self-start rounded-full bg-ink-wash py-1 pl-1 pr-3 text-sm text-ink">
        <Avatar size="sm">
          {avatar && avatar.startsWith("https://") && <AvatarImage src={avatar} alt="" />}
          <AvatarFallback>{name.charAt(0).toUpperCase()}</AvatarFallback>
        </Avatar>
        {name}
      </div>
      <AppearanceSettings value={value} onChange={onChange} subscription={workflow} />
    </>
  );
}
