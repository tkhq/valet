import { useState } from "react";
import type { InviteWire } from "@valet/api/wire";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  Input,
  Label,
  Spinner,
} from "~/components/primitives";
import { RadioCard } from "./radio-card";
import { useCreateInvite, useInvites, useRevokeInvite } from "~/api/invites";

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function inviteLink(code: string): string {
  return `${window.location.origin}/signup?invite=${code}`;
}

/**
 * Organization · Members' invite affordance (only shown to admins — the
 * caller passes that signal down rather than this component re-deriving
 * it, since `OrganizationMembersPage` already knows it from `useOrg()`).
 * "Invite" opens a dialog (optional email, role radio, default Member);
 * a successful create swaps the form for a contained link-reveal block
 * (same treatment as the API key secret reveal), then the pending list
 * below refreshes.
 */
export function InvitesPanel() {
  const invitesQ = useInvites();
  const [open, setOpen] = useState(false);

  return (
    <div className="space-y-3 pt-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-ink">Pending invites</h3>
        <Button type="button" size="sm" onClick={() => setOpen(true)}>
          Invite
        </Button>
      </div>

      {invitesQ.isLoading && (
        <div className="flex items-center gap-2 py-2 text-xs text-muted">
          <Spinner size={12} /> Loading…
        </div>
      )}
      {invitesQ.error && <p className="py-2 text-xs text-danger-500">Failed to load invites.</p>}
      {invitesQ.data && invitesQ.data.invites.length === 0 && (
        <p className="py-2 text-xs text-muted">No pending invites.</p>
      )}
      {invitesQ.data && invitesQ.data.invites.length > 0 && (
        <div className="divide-y divide-line border-t border-line">
          {invitesQ.data.invites.map((invite) => (
            <InviteRow key={invite.id} invite={invite} />
          ))}
        </div>
      )}

      <InviteDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

function InviteRow({ invite }: { invite: InviteWire }) {
  const [confirming, setConfirming] = useState(false);
  const revoke = useRevokeInvite();

  return (
    <div className="flex items-center gap-3 py-3 sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-ink">{invite.email ?? "anyone with the link"}</div>
        <div className="text-xs text-muted">Expires {formatDate(invite.expiresAt)}</div>
      </div>
      <Badge variant={invite.role === "admin" ? "accent" : "neutral"} className="shrink-0">
        {invite.role === "admin" ? "Admin" : "Member"}
      </Badge>
      {confirming ? (
        <span className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setConfirming(false)}
            disabled={revoke.isPending}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={revoke.isPending}
            onClick={() => revoke.mutate(invite.id, { onSuccess: () => setConfirming(false) })}
          >
            {revoke.isPending ? "Revoking…" : "Confirm revoke"}
          </Button>
        </span>
      ) : (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={() => setConfirming(true)}
        >
          Revoke
        </Button>
      )}
    </div>
  );
}

function InviteDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [code, setCode] = useState<string | null>(null);
  const createInvite = useCreateInvite();

  function reset() {
    setEmail("");
    setRole("member");
    setCode(null);
    createInvite.reset();
  }

  function submit() {
    createInvite.mutate(
      { email: email.trim() || undefined, role },
      { onSuccess: (created) => setCode(created.code) },
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      <DialogContent
        title={code ? "Invite created" : "Invite a member"}
        description={code ? undefined : "Leave email blank to create a link anyone can use to sign up."}
      >
        {code ? (
          <InviteLinkReveal code={code} />
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="invite-email">Email (optional)</Label>
              <Input
                id="invite-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="teammate@company.com"
              />
            </div>
            <div className="space-y-1.5">
              <span className="block text-sm font-medium text-ink">Role</span>
              <div role="radiogroup" aria-label="Role" className="flex gap-2">
                <RadioCard
                  title="Member"
                  description="Can use the app."
                  selected={role === "member"}
                  onSelect={() => setRole("member")}
                />
                <RadioCard
                  title="Admin"
                  description="Can manage org settings and members."
                  selected={role === "admin"}
                  onSelect={() => setRole("admin")}
                />
              </div>
            </div>
            {createInvite.error && (
              <p className="text-xs text-danger-500">{createInvite.error.message}</p>
            )}
          </div>
        )}

        <DialogFooter>
          {code ? (
            <Button type="button" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          ) : (
            <>
              <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={submit} disabled={createInvite.isPending}>
                {createInvite.isPending ? "Creating…" : "Create invite"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function InviteLinkReveal({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const link = inviteLink(code);

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be denied/unavailable — the link is still
      // selectable text in the block below.
    }
  }

  return (
    <div className="space-y-2 rounded-md border border-line bg-ink-wash p-4">
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded border border-line bg-[--bg] px-3 py-2 font-mono text-xs text-ink">
          {link}
        </code>
        <Button type="button" variant="secondary" size="sm" onClick={() => void copy()}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className="text-xs text-muted">
        Share this link. For Google or GitHub sign-in, the invite must include their email.
      </p>
    </div>
  );
}
