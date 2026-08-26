/**
 * Cards for `/integrations` (two-column facelift of the Task-15 connect
 * surface).
 *
 * One tile per plugin: the service's brand mark, name + connection state,
 * the description, and a footer with the mono "reach" meta (tool count /
 * "tools load on connect" / "no key needed") and the connect controls.
 * Built-in plugins get quieter wash tiles — present but visibly not asking
 * anything of you.
 *
 * A connected service also shows what its credential is worth: the account
 * it belongs to, and — when the token expired, failed to refresh, or
 * carries identity only — a badge, the fix, and a Reconnect control. See
 * `service-health.ts` for the states and `ServiceIcon` for the marks.
 *
 * GitHub carries a second line for the half its organisation owns — the
 * GitHub App, which the personal credential depends on to sign in and which
 * reaches repositories on its own. See `github-org-app.ts`.
 *
 * A service the deployment cannot connect carries no control at all. An org
 * admin still gets the tile, as an informational row naming the environment
 * variables to set; an unconnected member gets no tile. A Connect button
 * that cannot work is worse than no tile, so the row stays a statement, not
 * an offer. A member whose leftover credential keeps the tile on screen
 * reads the same cause without the variable names.
 *
 * Connect opens the pre-connect screen (`connect-dialog.tsx`) — for OAuth
 * services and manual-token services alike. The tile no longer runs any
 * connect path itself; it names the service and hands off. The submit action
 * is named "Connect" end to end (button → screen → form submit), never
 * "Save".
 */
import { useState } from "react";
import type { PluginServiceSummary, PluginSummary } from "@valet/api/wire";
import { Badge, Button } from "~/components/primitives";
import { useDisconnectCredential } from "~/api/integrations";
import { ServiceIcon } from "~/components/service-icon";
import { ConnectDialog } from "./connect-dialog";
import { displayName, pluginDisplayName } from "./display-name";
import { GithubOrgAppLine } from "./github-org-app-line";
import { IdentityLinkBlock, useServiceIdentityLink } from "./identity-link-block";
import { healthBadge, healthNote, needsReauth, serviceHealth } from "./service-health";


/** True when the plugin belongs in the Services group (something the assistant reaches out to). */
export function isService(plugin: PluginSummary): boolean {
  return plugin.actionCount > 0 || plugin.dynamic === true || plugin.services.length > 0;
}

/**
 * An unconfigured service (org/deployment prerequisite missing —
 * integration-availability design) renders in two cases: a leftover
 * credential still needs disconnecting, or the caller can fix the
 * configuration.
 *
 * Unconnected + unconfigured = no tile, for everybody else. A tile a person
 * cannot act on is noise, which is why the grid hides one.
 *
 * "Can fix it" is not decided here. The API sets `missingEnv` only for an
 * org admin (`org_members.role`), so the field's presence IS the permission
 * and a member's response never carries it. Visibility keys on `missingEnv`
 * for that reason, and never on `connectBlockedBy`, which every caller gets.
 */
export function isVisibleService(service: PluginServiceSummary): boolean {
  if (service.connect !== "unconfigured") return true;
  return service.connected || (service.missingEnv?.length ?? 0) > 0;
}

/** True when the plugin has anything left to show in the Services grid. */
export function hasVisibleSurface(plugin: PluginSummary): boolean {
  return plugin.services.length === 0 || plugin.services.some(isVisibleService);
}

function reachMeta(plugin: PluginSummary): string | null {
  if (plugin.actionCount > 0) {
    return `${plugin.actionCount} tool${plugin.actionCount === 1 ? "" : "s"}`;
  }
  if (plugin.dynamic) {
    // Connected dynamic services report a live-resolved count (`toolCount`,
    // TTL-cached server-side); before connecting — or when resolution timed
    // out — fall back to the static copy.
    const resolved = plugin.services.find((s) => s.toolCount !== undefined)?.toolCount;
    if (resolved !== undefined) {
      return `${resolved} tool${resolved === 1 ? "" : "s"}`;
    }
    return plugin.services.length === 0 ? "no key needed" : "tools load on connect";
  }
  return null;
}

/** The slug a card draws its mark from. A plugin declares one per service
 * (`plugin.yaml`), and a plugin that declares none falls back to its own
 * id — which is the slug for most of the fleet. */
function iconSlug(plugin: PluginSummary): string {
  return plugin.services[0]?.iconSlug ?? plugin.name;
}

/** The unset variable names, in prose: one name alone, two joined by "and",
 * more separated by commas. Each name is its own element so it reads as a
 * literal string and not as part of the sentence around it.
 *
 * The names arrive on the wire, from the plugin's own manifest. Nothing in
 * this file knows what a Google variable is called, so a second plugin with
 * different variables prints its own names and needs no change here. */
function EnvNames({ names }: { names: string[] }) {
  return (
    <>
      {names.map((name, index) => (
        <span key={name}>
          {index > 0 && (index === names.length - 1 ? " and " : ", ")}
          <code className="font-mono text-ink">{name}</code>
        </span>
      ))}
    </>
  );
}

/** GitHub is the only service whose organisation owns a second, separate
 * way in. Keyed on the credential service, the same key `connectPath` reads
 * to route GitHub through the org App's OAuth client. */
function orgNoteFor(service: PluginServiceSummary): React.ReactNode {
  return service.service === "github" ? <GithubOrgAppLine /> : undefined;
}

// ── Tiles ────────────────────────────────────────────────────────────────

export function IntegrationRow({ plugin }: { plugin: PluginSummary }) {
  const meta = reachMeta(plugin);
  const single = plugin.services.length === 1 ? plugin.services[0] : undefined;

  return (
    <div className="flex flex-col rounded-lg border border-line bg-paper p-4 transition-shadow hover:shadow-sm">
      {single ? (
        <ServiceBlock
          service={single}
          title={pluginDisplayName(plugin)}
          slug={single.iconSlug ?? plugin.name}
          description={plugin.description}
          meta={meta}
          orgNote={orgNoteFor(single)}
        />
      ) : (
        <>
          <CardHeading
            title={pluginDisplayName(plugin)}
            slug={iconSlug(plugin)}
            description={plugin.description}
          />
          <CardFooter meta={meta} />
          {/* Multi-service plugins (none in the current fleet, but the manifest
              allows it): each credential service gets its own quiet sub-row. */}
          {plugin.services.length > 1 && (
            <ul className="mt-3 space-y-3 border-t border-line pt-3">
              {plugin.services.filter(isVisibleService).map((service) => (
                <li key={service.service}>
                  <ServiceBlock
                    service={service}
                    title={displayName(service.service)}
                    slug={service.iconSlug ?? service.service}
                    orgNote={orgNoteFor(service)}
                  />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

export function BuiltInRow({ plugin }: { plugin: PluginSummary }) {
  return (
    <div className="flex items-start gap-3 rounded-lg bg-ink-wash p-4">
      <ServiceIcon slug={iconSlug(plugin)} label={pluginDisplayName(plugin)} tone="quiet" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-ink">{pluginDisplayName(plugin)}</div>
        {plugin.description && (
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">
            {plugin.description}
          </p>
        )}
      </div>
      <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-muted">
        built in
      </span>
    </div>
  );
}

function CardHeading({
  title,
  slug,
  description,
  state,
}: {
  title: string;
  slug: string;
  description?: string;
  state?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <ServiceIcon slug={slug} label={title} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-ink">{title}</span>
          {state}
        </div>
        {description && (
          <p className="mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted">{description}</p>
        )}
      </div>
    </div>
  );
}

function CardFooter({ meta, right }: { meta?: string | null; right?: React.ReactNode }) {
  return (
    <div className="mt-auto flex items-center justify-between gap-3 pt-4">
      <span className="font-mono text-xs text-muted">{meta ?? ""}</span>
      {right}
    </div>
  );
}

/** A service's tile content + connect state, owning its own token-reveal state. */
function ServiceBlock({
  service,
  title,
  slug,
  description,
  meta,
  orgNote,
}: {
  service: PluginServiceSummary;
  title: string;
  slug: string;
  description?: string;
  meta?: string | null;
  /** A second connection the organisation owns, stated beside this one
   * rather than merged into it. Only GitHub has one — see `orgNoteFor`. */
  orgNote?: React.ReactNode;
}) {
  const [connecting, setConnecting] = useState(false);
  const disconnect = useDisconnectCredential();
  const health = serviceHealth(service);
  const badge = healthBadge(health);
  const note = healthNote(health);
  // A broken connection keeps its row in the credential store, so the card
  // offers the repair beside the disconnect instead of only "Disconnect".
  const repair = needsReauth(health);
  const connectLabel = repair ? "Reconnect" : "Connect";
  // No connect affordance for an unconfigured service — its tile exists only
  // so a leftover credential can be disconnected, or so an org admin can read
  // what to set (integration-availability design). The note below names where
  // the setup actually happens.
  const unconfigured = service.connect === "unconfigured";
  // "org": the org credential provides the service and there is nothing for
  // the user to connect. The tile states that instead of offering token
  // entry — the Slack bot token, for one, belongs to Settings → Organization.
  const orgProvided = service.connect === "org";
  // Present only for an org admin, and only for the missing-OAuth-client
  // arm. See `isVisibleService`.
  const missingEnv = service.missingEnv ?? [];

  // Every connect path — the org's GitHub App OAuth, the generic per-service
  // OAuth redirect, and manual token entry — now opens the same pre-connect
  // screen first. That screen states what the credential gives the assistant
  // and who can reach it; the three paths resume behind its Continue button.
  // The OAuth path in particular USED to be a bare anchor straight to
  // /api/credentials/:service/connect, which left no moment between the click
  // and the redirect in which to say anything.
  // The visible label stays one word, but the grid holds a dozen identical
  // "Connect" buttons — so each one names its service to a screen reader.
  const connectControl = (
    <Button size="sm" aria-label={`${connectLabel} ${title}`} onClick={() => setConnecting(true)}>
      {connectLabel}
    </Button>
  );

  const disconnectControl = (
    <Button
      variant="ghost"
      size="sm"
      aria-label={`Disconnect ${title}`}
      onClick={() => {
        if (!confirm(`Disconnect ${title}?`)) return;
        void disconnect.mutateAsync({ service: service.service });
      }}
      disabled={disconnect.isPending}
    >
      {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
    </Button>
  );

  const controls = !service.connected ? (
    unconfigured || orgProvided ? null : connectControl
  ) : repair && !unconfigured && !orgProvided ? (
    <span className="flex items-center gap-3">
      {disconnectControl}
      {connectControl}
    </span>
  ) : (
    disconnectControl
  );

  // Two reasons a service is unconfigured, and two different fixes. The
  // cause arrives for every reader (`connectBlockedBy`); the variable names
  // arrive for an org admin alone. So there are three notes:
  //
  //   deployment + names  → set these variables, then restart the server
  //   deployment, no names → ask an org admin (no page in the product sets
  //                          a server variable, so this must not name one)
  //   org                  → Settings → Organization, which does set it
  const unconfiguredNote = !unconfigured ? undefined : missingEnv.length > 0 ? (
    <p className="text-xs leading-relaxed text-muted">
      This deployment has no OAuth client for this service. Set{" "}
      <EnvNames names={missingEnv} /> in the server environment. Then restart the server.
    </p>
  ) : service.connectBlockedBy === "deployment" ? (
    <p className="text-xs leading-relaxed text-muted">
      This deployment has no OAuth client for this service. Ask an org admin to set it up.
    </p>
  ) : (
    <p className="text-xs leading-relaxed text-muted">
      Not configured for this organization. An admin can set this up in Settings → Organization.
    </p>
  );

  // The org-provided tile carries the member's OWN step in place of token
  // entry: pairing their account through the identity-link code flow, for
  // providers that declare one (the hook returns null otherwise, and for a
  // provider whose transport is not ready). The generic note stands in when
  // there is no pairing to offer — and is HELD while the link list loads,
  // so the tile does not flash the note before the pairing block swaps in.
  const identityLink = useServiceIdentityLink(service.service);
  const pairing = orgProvided && identityLink.link?.channelReady ? identityLink.link : null;
  const orgProvidedNote =
    orgProvided && !pairing && !identityLink.isLoading ? (
      <p className="text-xs leading-relaxed text-muted">
        Provided by your organization. An admin manages it in Settings → Organization.
      </p>
    ) : undefined;

  return (
    <>
      <CardHeading
        title={title}
        slug={slug}
        description={description}
        state={badge ? <Badge variant={badge.variant}>{badge.label}</Badge> : undefined}
      />
      {/* The org note reads on a disconnected card too — "your organisation
          has no GitHub App" is the reason Connect is about to fail — so the
          stack no longer hangs off `service.connected` alone. */}
      {(orgNote || unconfiguredNote || pairing || orgProvidedNote || (service.connected && (service.health?.login || note))) && (
        <div className="mt-1.5 space-y-1 pl-12">
          {unconfiguredNote}
          {pairing ? <IdentityLinkBlock link={pairing} title={title} /> : orgProvidedNote}
          {service.connected && service.health?.login && (
            <p className="truncate text-xs text-muted">Account: {service.health.login}</p>
          )}
          {service.connected && note && (
            <p
              className={
                health === "identity-only"
                  ? "text-xs leading-relaxed text-warning-fg"
                  : "text-xs leading-relaxed text-danger-500"
              }
            >
              {note}
            </p>
          )}
          {orgNote}
        </div>
      )}
      <CardFooter meta={meta} right={controls} />
      <ConnectDialog
        service={service}
        title={title}
        slug={slug}
        open={connecting}
        onOpenChange={setConnecting}
      />
    </>
  );
}
