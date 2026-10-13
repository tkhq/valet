import type { NormalizedEvent } from "@valet/engine";

/**
 * Host capabilities for GitHub's HTTP routes. The API binds each object to a
 * host-derived identity before a handler runs: the authenticated caller, the
 * organization a signed state names, or the organization that owns the App.
 * No method accepts a user or organization ID.
 */

/** Host configuration, read for each request. */
export interface GithubEndpoints {
  /** Browser base URL, such as `https://github.com`. */
  githubUrl: string;
  /** REST base URL, such as `https://api.github.com`. */
  githubApiUrl: string;
  /** This instance's public base URL. Null when GitHub cannot reach it. */
  publicUrl: string | null;
}

export interface GithubAppInstallationSummary {
  id: string;
  installationId: number;
  accountLogin: string;
  accountType: string;
  repositorySelection: string | null;
  suspended: boolean;
  linkedUserId: string | null;
}

/** Host-owned storage view of the organization's App. */
export interface GithubAppStatus {
  configured: boolean;
  source?: "org" | "environment";
  app?: { appId: string; appSlug: string; htmlUrl: string; installUrl: string };
  installations: GithubAppInstallationSummary[];
  webhook: { mode: "public" | "manual" };
  installationsCheckedAt: number | null;
}

/** Host-owned member view of the organization's App. */
export interface GithubOrgStatus {
  configured: boolean;
  installationCount: number;
  suspendedCount: number;
  personalInstallUrl?: string;
}

/** Parts of an App credential. The host fills the page URL and empty secrets. */
export interface GithubAppConfigInput {
  appId: string;
  appSlug: string;
  oauthClientId: string;
  privateKeyPem: string;
  oauthClientSecret?: string;
  webhookSecret?: string;
  htmlUrl?: string;
}

export type GithubAppCredentialCheck =
  | { ok: true; app: { appId: string; appSlug?: string; htmlUrl?: string; oauthClientId?: string } }
  | { ok: false; error: string };

export interface GithubAppCapability {
  status(): Promise<GithubAppStatus>;
  /** The organization name, or its ID when the organization row is missing. */
  orgName(): Promise<string>;
  /** Signs a 15-minute setup state for the calling admin, their organization, and the return origin. */
  signSetupState(): string;
  /** Asks GitHub whether the App ID and key match. Stores nothing and never throws. */
  checkCredential(credential: { appId: string; privateKeyPem: string }): Promise<GithubAppCredentialCheck>;
  /** Stores the App, then discovers installations and syncs the webhook URL on a best-effort basis. */
  saveApp(input: GithubAppConfigInput): Promise<void>;
  /** False when GitHub discovery fails. */
  refreshInstallations(): Promise<boolean>;
  /** Removes the stored App and its installation rows. */
  disconnect(): Promise<void>;
}

export interface GithubSetupCapability {
  /** Opens the state for the signed-in caller. Never calls GitHub or stores anything. */
  open(state: string): Promise<GithubSetupOpening>;
}

export type GithubSetupOpening =
  /** A tampered, malformed, or expired state, or a state another flow signed. */
  | { status: "invalid" }
  /** The state is valid, but the caller is not the org admin who started setup, or is no longer an org admin. */
  | { status: "refused" }
  | { status: "open"; grant: GithubSetupGrant };

export interface GithubSetupGrant {
  /** Allow-listed browser origin, or empty for same-origin redirects. */
  returnTo: string;
  /** Stores the App for the organization the state names. */
  saveApp(input: GithubAppConfigInput): Promise<void>;
}

export type GithubPostAuthDestination = "integrations";

export interface GithubConnectionCapability {
  /** The OAuth client ID of the caller organization's App. Null when no App exists. */
  oauthClientId(): Promise<string | null>;
  /** Signs a 15-minute connect state for the caller and return origin. */
  signConnectState(postAuthDestination?: GithubPostAuthDestination): string;
  orgStatus(): Promise<GithubOrgStatus>;
  openCallback(state: string): GithubCallbackOpening;
  /** Removes the caller's GitHub credential, its team shares, and installation links. */
  disconnect(): Promise<void>;
}

export type GithubCallbackOpening =
  | { status: "invalid" }
  /** The state is valid but names a different user. */
  | { status: "other-user" }
  | { status: "open"; grant: GithubCallbackGrant };

export interface GithubCallbackGrant {
  returnTo: string;
  postAuthDestination?: GithubPostAuthDestination;
  /** The App OAuth client of the organization the state names. Null when no App exists. */
  oauthClient(): Promise<{ clientId: string; clientSecret: string } | null>;
  /** Saves the caller's credential, refreshes readiness, and relinks installations. */
  saveConnection(connection: GithubUserConnection): Promise<void>;
}

export interface GithubUserConnection {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  login: string;
}

export interface GithubWebhookCapability {
  /** Null when no App is configured. Exposes no organization and calls no provider. */
  openDelivery(): Promise<GithubWebhookDelivery | null>;
}

export interface GithubWebhookDelivery {
  /** Empty for an App created without webhooks. An empty secret never verifies. */
  webhookSecret: string;
  /**
   * Binds effects to the App owner's organization. Call it only after the
   * signature verifies. The environment fallback routes by the verified
   * installation ID. Null when no organization exists.
   */
  bind(verified: { installationId: number | null }): Promise<GithubDeliveryEffects | null>;
}

export type GithubPullRequestState = "open" | "closed" | "merged";

export interface GithubPushRef {
  repoFullName: string;
  gitRef: string;
  defaultBranch: string;
}

export interface GithubDeliveryEffects {
  /** Marks matching content sources due. */
  contentPushed(push: GithubPushRef): Promise<void>;
  pullRequestChanged(change: { url: string; state: GithubPullRequestState }): Promise<void>;
  installationRemoved(installationId: number): Promise<void>;
  installationSuspended(installationId: number, suspended: boolean): Promise<void>;
  repositorySelectionChanged(installationId: number, repositorySelection: string | undefined): Promise<void>;
  /** Re-reads installations from GitHub. */
  discoverInstallations(): Promise<void>;
  /** Persists the event and starts subscription dispatch. */
  emit(event: NormalizedEvent): Promise<void>;
  /** Records a verified delivery that no trigger can ingest. */
  recordUndeliverable(notice: { detail: string; deliveryId?: string }): Promise<void>;
}
