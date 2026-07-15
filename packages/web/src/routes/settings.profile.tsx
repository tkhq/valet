import { createFileRoute } from "@tanstack/react-router";
import { Section } from "~/components/settings/section";

/**
 * `/settings/profile` — You · Profile. Placeholder stub; Task 6 wires
 * `GET/PATCH /api/me` into name/avatar/email fields.
 */
export const Route = createFileRoute("/settings/profile")({
  component: ProfilePage,
});

export function ProfilePage() {
  return (
    <Section title="Profile" description="Your name, avatar, and sign-in email.">
      <p className="py-4 text-sm text-muted">Profile editing lands here next.</p>
    </Section>
  );
}
