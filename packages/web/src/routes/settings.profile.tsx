import { useEffect, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";
import { FieldRow } from "~/components/settings/field-row";
import { EnableOrgCard } from "~/components/settings/enable-org-card";
import { Avatar, AvatarFallback, AvatarImage, Button, Input, Spinner } from "~/components/primitives";
import { useHasPermission, useMe, useOrg, usePatchMe } from "~/api/settings";
import { authClient } from "~/lib/auth-client";

/**
 * `/settings/profile` — You · Profile. Name + avatar URL, one Save enabled
 * when either field is dirty; read-only email row; the enable-organizations
 * card at the bottom for org admins with the gate off (spec: "the rail's
 * You group is per-route; the card belongs to one page — profile is the
 * landing page").
 */
export const Route = createFileRoute("/settings/profile")({
  component: ProfilePage,
});

export function ProfilePage() {
  const meQ = useMe();
  const orgQ = useOrg();
  const patchMe = usePatchMe();

  const [name, setName] = useState("");
  const [avatarUrl, setAvatarUrl] = useState("");

  // Seed local edit state once `/api/me` resolves; re-seed if the server
  // value changes underneath us (e.g. after a successful save).
  useEffect(() => {
    if (meQ.data) {
      setName(meQ.data.name ?? "");
      setAvatarUrl(meQ.data.avatarUrl ?? "");
    }
  }, [meQ.data?.name, meQ.data?.avatarUrl]);

  const dirty =
    !!meQ.data && (name !== (meQ.data.name ?? "") || avatarUrl !== (meQ.data.avatarUrl ?? ""));

  function save() {
    if (!dirty) return;
    patchMe.mutate({ name, avatarUrl });
  }

  const canManageOrg = useHasPermission("org:manage");
  const showEnableCard = canManageOrg && orgQ.data?.features.organizations === false;

  async function signOut() {
    await authClient.signOut();
    window.location.href = "/login";
  }

  return (
    <div className="space-y-10">
      <Section title="Profile" description="Your name, avatar, and sign-in email.">
        {meQ.isLoading && (
          <div className="flex items-center gap-2 py-4 text-sm text-muted">
            <Spinner size={14} /> Loading…
          </div>
        )}
        {meQ.error && (
          <div className="py-4 text-sm text-danger-500">Failed to load your profile.</div>
        )}
        {meQ.data && (
          <>
            <FieldRow label="Name">
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                aria-label="Name"
              />
            </FieldRow>
            <FieldRow label="Avatar" hint="Paste an image URL.">
              <div className="flex items-center gap-3">
                <Avatar size="lg">
                  <AvatarImage src={avatarUrl || undefined} alt="" />
                  <AvatarFallback>{(name || "?").slice(0, 1).toUpperCase()}</AvatarFallback>
                </Avatar>
                <Input
                  value={avatarUrl}
                  onChange={(e) => setAvatarUrl(e.target.value)}
                  placeholder="https://…"
                  aria-label="Avatar URL"
                  className="flex-1"
                />
              </div>
            </FieldRow>
            <FieldRow
              label="Email"
              hint="Sign-in email — managed by your login once real auth ships."
            >
              <Input value={meQ.data.email} readOnly disabled aria-label="Email" />
            </FieldRow>

            <div className="flex items-center gap-3 py-4">
              <Button type="button" onClick={save} disabled={!dirty || patchMe.isPending}>
                {patchMe.isPending ? "Saving…" : "Save"}
              </Button>
              {patchMe.error && (
                <p className="text-xs text-danger-500">{patchMe.error.message}</p>
              )}
            </div>
          </>
        )}
      </Section>

      <Section title="Sign out" description="Sign out of Valet on this device.">
        <div className="py-4">
          <Button type="button" variant="secondary" onClick={signOut}>
            Sign out
          </Button>
        </div>
      </Section>

      {showEnableCard && <EnableOrgCard />}
    </div>
  );
}
