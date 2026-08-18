/**
 * The pre-connect screen: what a user hands over, and who can reach it,
 * shown BEFORE the credential exists rather than in a settings page after.
 *
 * Split pane. The left column is the decision — what happens, which account
 * signs in, what the assistant will be able to do, and who else can reach
 * it. The right column previews the tools this specific credential unlocks,
 * read from the plugin's declared actions. On a narrow screen the two stack
 * and the decision comes first.
 *
 * Every sentence here comes out of `connect-disclosure.ts`, which derives it
 * from `PluginServiceSummary` and refuses to produce copy for a service
 * whose metadata cannot support the claim. Nothing on this screen is written
 * per service by hand — add a plugin and the screen describes it correctly,
 * or says plainly that it cannot.
 *
 * WHAT THIS SCREEN DELIBERATELY DOES NOT DO: it does not offer a visibility
 * choice. The obvious two — "only me" vs "shared with my organisation", and
 * per-team sharing — are both unenforceable today. A session resolves every
 * credential as `{ type: "user", id: userId }`, so an org-scoped row is
 * writable but no plugin action ever reads it, and `CredentialOwner` has no
 * team arm at all. Rendering that choice would put a control on screen that
 * moves a row between columns and changes nothing about who can use the
 * token — a privacy promise the backend does not keep. Instead the second
 * card states the exposure that IS real. See the design note in the PR.
 */
import { useEffect, useState } from "react";
import { Lock, ShieldAlert, ShieldCheck, User, Users } from "lucide-react";
import type { PluginServiceSummary } from "@valet/api/wire";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  Avatar,
  AvatarFallback,
  AvatarImage,
  ScrollArea,
  Textarea,
} from "~/components/primitives";
import { useConnectCredential } from "~/api/integrations";
import { useConnectGithub, useGithubOrgStatus } from "~/api/repos";
import { useMe, useTeams } from "~/api/settings";
import { ServiceIcon } from "~/components/service-icon";
import { cn } from "~/lib/cn";
import { errorText } from "~/lib/error-text";
import {
  capabilityLines,
  reachLines,
  summaryLines,
  toolDisclosure,
  type ReachableTeam,
} from "./connect-disclosure";
import { githubOrgReachLines } from "./github-org-app";

const TOKEN_FIELD_LABEL: Record<PluginServiceSummary["type"], string> = {
  api_key: "API key",
  oauth2: "Access token",
  bot_token: "Bot token",
  service_account: "Service account key",
};

interface ConnectDialogProps {
  service: PluginServiceSummary;
  title: string;
  slug: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Which connect path Continue starts. GitHub goes through the org's own App
 * OAuth route rather than the generic per-service redirect, because its
 * manifest declares no oauth metadata on purpose — the App's configured
 * permissions govern, not a scope list Valet sends.
 *
 * `connect: "unconfigured"` and `connect: "org"` never reach here in
 * practice — the tile suppresses its Connect control (`integration-row.tsx`)
 * — but the mapping stays total: manual is the harmless default, and the
 * server rejects the save anyway.
 */
export function connectPath(service: PluginServiceSummary): "github" | "oauth" | "manual" {
  if (service.service === "github") return "github";
  return service.connect === "oauth" ? "oauth" : "manual";
}

export function ConnectDialog({ service, title, slug, open, onOpenChange }: ConnectDialogProps) {
  // Step two is token entry, for the manual path and for the "enter a token
  // instead" escape hatch on OAuth services. Reset whenever the dialog
  // reopens so a cancelled attempt never reopens mid-flow.
  const [step, setStep] = useState<"disclose" | "token">("disclose");
  useEffect(() => {
    if (open) setStep("disclose");
  }, [open]);

  const disclosure = toolDisclosure(service);
  const path = connectPath(service);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-3xl gap-0 overflow-hidden p-0 lg:max-w-4xl xl:max-w-5xl"
        aria-describedby={undefined}
      >
        {/* One scroller on narrow screens, where the panes stack. From `lg`
            the panes sit side by side and each scrolls on its own, so a long
            tool list cannot push the decision pane's Continue button out of
            reach. `lg:overflow-hidden` on the grid is what makes the child
            scrollers the ones that move; `overflow-visible` here left the
            taller pane clipped with nowhere to scroll. */}
        <div className="grid max-h-[85vh] grid-cols-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_18rem] lg:overflow-hidden xl:grid-cols-[minmax(0,1fr)_20rem]">
          <DecisionPane
            service={service}
            title={title}
            slug={slug}
            path={path}
            step={step}
            onEnterToken={() => setStep("token")}
            onDone={() => onOpenChange(false)}
            disclosure={disclosure}
          />
          <PreviewPane service={service} title={title} slug={slug} disclosure={disclosure} />
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Left: the decision ───────────────────────────────────────────────────

function DecisionPane({
  service,
  title,
  slug,
  path,
  step,
  onEnterToken,
  onDone,
  disclosure,
}: {
  service: PluginServiceSummary;
  title: string;
  slug: string;
  path: "github" | "oauth" | "manual";
  step: "disclose" | "token";
  onEnterToken: () => void;
  onDone: () => void;
  disclosure: ReturnType<typeof toolDisclosure>;
}) {
  const me = useMe();
  const teamsQuery = useTeams();
  const connectGithub = useConnectGithub();
  // GitHub is the only service with an organisation-owned second half, and
  // the only one whose Continue can fail because that half is missing. The
  // card states both; every other service skips the request.
  const orgStatus = useGithubOrgStatus(path === "github");

  // Org admins see every team in the org, but `callerRole` is null unless
  // they are actually on it. Only real memberships create the exposure the
  // second card names, so anything else must not be listed as one.
  const teams: ReachableTeam[] = (teamsQuery.data?.teams ?? [])
    .filter((team) => team.callerRole !== null)
    .map((team) => ({ name: team.name, memberCount: team.memberCount }));

  // A service whose declared key no tool reads cannot be described, so the
  // screen refuses to start the connection rather than describe it wrongly.
  const blocked = disclosure.kind === "unknown";

  async function onContinue() {
    if (blocked) return;
    if (path === "manual") return onEnterToken();
    if (path === "github") {
      try {
        const res = await connectGithub.mutateAsync();
        window.location.href = res.url;
      } catch {
        // Surfaced below via connectGithub.error.
      }
      return;
    }
    window.location.href = `/api/credentials/${encodeURIComponent(service.service)}/connect`;
  }

  if (step === "token") {
    return (
      <div className="flex flex-col gap-4 p-6">
        <DialogTitle className="font-display text-xl text-ink">
          Paste your {title} token
        </DialogTitle>
        <TokenForm service={service} title={title} onDone={onDone} />
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-5 overflow-y-auto p-6">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <DialogTitle className="font-display text-xl text-ink">
            Set up your {title} connection
          </DialogTitle>
          {service.connected && <Badge variant="success">Connected</Badge>}
        </div>
        <div className="space-y-1">
          {summaryLines(disclosure, title).map((line) => (
            <p key={line} className="text-sm leading-relaxed text-muted">
              {line}
            </p>
          ))}
        </div>
      </header>

      <IdentityChip
        title={title}
        path={path}
        avatarUrl={me.data?.avatarUrl ?? null}
        name={me.data?.name ?? ""}
        email={me.data?.email ?? ""}
        connectedAs={service.health?.login}
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <FactCard
          heading="What your assistant can do"
          lines={capabilityLines(disclosure, title)}
          illustration={<CapabilityMock disclosure={disclosure} />}
        />
        <FactCard
          heading="Who can reach it"
          lines={[...reachLines(teams, title), ...githubOrgReachLines(service.service, orgStatus.data)]}
          illustration={<ReachMock teams={teams} slug={slug} />}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Button size="lg" className="w-full" onClick={() => void onContinue()} disabled={blocked || connectGithub.isPending}>
          {connectGithub.isPending ? "Opening GitHub…" : service.connected ? "Reconnect" : "Continue"}
        </Button>
        {/* The escape hatch still sits behind the disclosure, never beside it. */}
        {path !== "manual" && !blocked && (
          <button
            type="button"
            className="text-xs text-muted underline-offset-2 hover:underline"
            onClick={onEnterToken}
          >
            Enter a token instead
          </button>
        )}
        {/* `Error.message` here is the request line ("POST /me/github/connect
            → 409"), which tells a reader nothing. The server's own sentence
            names the fix — an admin must set up the App — and rides in the
            payload, so read it out with the house helper. */}
        {connectGithub.error && (
          <p role="alert" className="text-xs text-danger-500">
            {errorText(connectGithub.error)}
          </p>
        )}
      </div>

      <p className="flex items-start gap-2 border-t border-line pt-4 text-xs leading-relaxed text-muted">
        <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          Valet encrypts this token before it saves it. To remove it later, go to{" "}
          <a
            href="/settings/connected-accounts"
            className="text-ink underline underline-offset-2"
          >
            Connected accounts
          </a>
          .
        </span>
      </p>
    </div>
  );
}

/**
 * Which account is being connected. Valet knows its OWN user, and says so —
 * it does not know the third-party account, because the user picks that on
 * the provider's consent screen and the generic callback saves no login.
 * Printing a mailbox here would be an invention.
 */
function IdentityChip({
  title,
  path,
  avatarUrl,
  name,
  email,
  connectedAs,
}: {
  title: string;
  path: "github" | "oauth" | "manual";
  avatarUrl: string | null;
  name: string;
  email: string;
  connectedAs?: string;
}) {
  const initials = (name || email || "?").slice(0, 1).toUpperCase();
  return (
    <div className="flex items-start gap-3 rounded-md border border-line bg-ink-wash p-3">
      <Avatar size="md">
        {avatarUrl && <AvatarImage src={avatarUrl} alt="" />}
        <AvatarFallback>{initials}</AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted">Connecting as your Valet account</p>
        {name && <p className="truncate text-sm font-medium text-ink">{name}</p>}
        {email && <p className="truncate text-xs text-muted">{email}</p>}
        <p className="mt-1 text-xs leading-relaxed text-muted">
          {path === "manual"
            ? `The token you paste decides which ${title} account Valet uses.`
            : `You choose which ${title} account to use on the next screen.`}
        </p>
        {connectedAs && (
          <p className="mt-1 truncate text-xs text-muted">Connected now as {connectedAs}.</p>
        )}
      </div>
    </div>
  );
}

/**
 * One statement of fact, with a small picture of the state it describes.
 *
 * These carry the visual weight of a choice without being one — see the file
 * header. They are `<section>`s with headings, not radios, so a screen
 * reader announces two labelled statements rather than two options a user
 * would then look for a way to pick between.
 */
function FactCard({
  heading,
  lines,
  illustration,
}: {
  heading: string;
  lines: string[];
  illustration: React.ReactNode;
}) {
  return (
    <section
      aria-label={heading}
      className="flex flex-col gap-2 rounded-md border border-line bg-paper p-3"
    >
      <div className="rounded bg-ink-wash p-2">{illustration}</div>
      <h3 className="text-sm font-medium text-ink">{heading}</h3>
      <div className="space-y-1">
        {lines.map((line) => (
          <p key={line} className="text-xs leading-relaxed text-muted">
            {line}
          </p>
        ))}
      </div>
    </section>
  );
}

/** Two mock tool rows: one the gate stops, one it does not. */
function CapabilityMock({ disclosure }: { disclosure: ReturnType<typeof toolDisclosure> }) {
  const asking = disclosure.kind === "known" && disclosure.asking.length > 0;
  return (
    <div className="space-y-1" aria-hidden>
      <div className="flex items-center gap-1.5 rounded-sm bg-paper px-1.5 py-1">
        <ShieldCheck className="h-3 w-3 shrink-0 text-muted" />
        <span className="h-1.5 flex-1 rounded-full bg-ink-wash-strong" />
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted">runs</span>
      </div>
      <div
        className={cn(
          "flex items-center gap-1.5 rounded-sm px-1.5 py-1",
          asking ? "bg-moss-wash" : "bg-paper",
        )}
      >
        {asking ? (
          <Lock className="h-3 w-3 shrink-0 text-ink" />
        ) : (
          <ShieldAlert className="h-3 w-3 shrink-0 text-muted" />
        )}
        <span className="h-1.5 flex-1 rounded-full bg-ink-wash-strong" />
        <span className="font-mono text-[9px] uppercase tracking-wide text-muted">
          {asking ? "asks" : "runs"}
        </span>
      </div>
    </div>
  );
}

/** You alone, or you plus the people who can reach a team assistant. */
function ReachMock({ teams, slug }: { teams: ReachableTeam[]; slug: string }) {
  const others = teams.reduce((most, team) => Math.max(most, team.memberCount - 1), 0);
  return (
    <div className="flex items-center gap-1.5" aria-hidden>
      <ServiceIcon slug={slug} label="" tone="quiet" className="h-6 w-6 rounded-sm" />
      <span className="text-muted">→</span>
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-moss-wash-strong">
        {teams.length > 0 ? (
          <Users className="h-3 w-3 text-ink" />
        ) : (
          <User className="h-3 w-3 text-ink" />
        )}
      </span>
      {others > 0 && (
        <span className="font-mono text-[10px] text-muted">+{others}</span>
      )}
    </div>
  );
}

// ── Right: what this credential unlocks ──────────────────────────────────

function PreviewPane({
  service,
  title,
  slug,
  disclosure,
}: {
  service: PluginServiceSummary;
  title: string;
  slug: string;
  disclosure: ReturnType<typeof toolDisclosure>;
}) {
  return (
    <aside className="flex min-h-0 min-w-0 flex-col overflow-y-auto border-t border-line bg-ink-wash p-5 lg:border-l lg:border-t-0">
      <div className="flex items-center gap-2">
        <ServiceIcon slug={slug} label={title} />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-ink">{title}</p>
          <p className="font-mono text-[10px] uppercase tracking-wider text-muted">
            {disclosure.kind === "known"
              ? `${disclosure.total} tool${disclosure.total === 1 ? "" : "s"}`
              : "tools unknown"}
          </p>
        </div>
      </div>

      {disclosure.kind === "known" ? (
        <ScrollArea className="mt-4 max-h-72 lg:max-h-[26rem]">
          <ul className="space-y-1 pr-2">
            {[...disclosure.asking, ...disclosure.running].map((action) => (
              <li
                key={action.name}
                className="flex items-center justify-between gap-2 rounded-sm bg-paper px-2 py-1.5"
              >
                <span className="min-w-0 truncate text-xs text-ink">{action.name}</span>
                {action.requiresApproval && (
                  <Badge variant="accent" className="shrink-0">
                    Asks you first
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        </ScrollArea>
      ) : (
        <p className="mt-4 text-xs leading-relaxed text-muted">
          {disclosure.kind === "on-connect"
            ? `${title} tells Valet which tools it offers after you connect. Valet lists them here from then on.`
            : `Valet has no tool list for this connection. Connecting it does not give your assistant ${title} tools.`}
        </p>
      )}

      {service.scopes && service.scopes.length > 0 && (
        <div className="mt-4 border-t border-line pt-3">
          <p className="text-[11px] font-medium text-ink">Access Valet asks {title} for</p>
          <ul className="mt-1 space-y-0.5">
            {service.scopes.map((scope) => (
              <li key={scope} className="break-all font-mono text-[10px] leading-relaxed text-muted">
                {scope}
              </li>
            ))}
          </ul>
        </div>
      )}
    </aside>
  );
}

// ── Token entry ──────────────────────────────────────────────────────────

function TokenForm({
  service,
  title,
  onDone,
}: {
  service: PluginServiceSummary;
  title: string;
  onDone: () => void;
}) {
  const [token, setToken] = useState("");
  const connect = useConnectCredential();
  const fieldLabel = TOKEN_FIELD_LABEL[service.type];

  async function submit() {
    const trimmed = token.trim();
    if (!trimmed) return;
    try {
      await connect.mutateAsync({
        service: service.service,
        body:
          service.type === "api_key"
            ? { type: service.type, apiKey: trimmed }
            : { type: service.type, accessToken: trimmed },
      });
      setToken("");
      onDone();
    } catch {
      // useMutation surfaces the error via `connect.error`; the form stays open.
    }
  }

  return (
    <div className="space-y-3">
      {service.connectLabel && <p className="text-xs text-muted">{service.connectLabel}</p>}
      <label className="block text-xs font-medium text-ink" htmlFor={`token-${service.service}`}>
        {fieldLabel}
      </label>
      <Textarea
        id={`token-${service.service}`}
        rows={3}
        value={token}
        onChange={(e) => setToken(e.target.value)}
        placeholder={`Paste the ${fieldLabel.toLowerCase()}…`}
        autoFocus
      />
      {connect.error && (
        <div
          role="alert"
          className="rounded border border-line bg-danger-wash px-3 py-2 text-xs text-danger-600"
        >
          {connect.error.message}
        </div>
      )}
      <Button
        size="lg"
        className="w-full"
        onClick={() => void submit()}
        disabled={connect.isPending || !token.trim()}
      >
        {connect.isPending ? "Connecting…" : `Connect ${title}`}
      </Button>
    </div>
  );
}
