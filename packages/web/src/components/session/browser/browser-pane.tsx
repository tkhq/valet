import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Camera,
  Globe,
  LockKeyhole,
  Plus,
  RotateCw,
  X,
} from "lucide-react";
import type {
  BrowserArtifact,
  BrowserHumanInput,
  BrowserRuntimeStatus,
} from "@valet/shared";
import {
  browserApi,
  useBrowserActions,
  useBrowserFrame,
  useBrowserStatus,
} from "~/api/browser";
import { Button, Input, Spinner } from "~/components/primitives";
import { cn } from "~/lib/cn";
import { BrowserViewport } from "./browser-viewport";
import { EvidenceAnnotations } from "./evidence-annotations";
import { normalizeBrowserAddress } from "./input";

const STATE_LABEL: Record<BrowserRuntimeStatus["state"], string> = {
  installed: "Ready to start",
  starting: "Starting browser",
  ready: "Browser ready",
  sleeping: "Browser sleeping",
  crashed: "Browser stopped",
  incompatible: "Browser update required",
  disabled: "Browser disabled",
};

export function BrowserPane({ sessionId }: { sessionId: string }) {
  const query = useBrowserStatus(sessionId);
  const actions = useBrowserActions(sessionId);
  const data = query.data;
  const runtime = data?.status;
  const [chosenTab, setChosenTab] = useState<string | null>(null);
  const selected =
    runtime?.tabs.find((tab) => tab.id === chosenTab) ??
    runtime?.tabs.find((tab) => tab.id === runtime.selectedTabId) ??
    runtime?.tabs[0];
  const [address, setAddress] = useState("");
  const touchedAddress = useRef(false);
  const addressTab = useRef<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [capture, setCapture] = useState<BrowserArtifact | null>(null);
  const [annotating, setAnnotating] = useState(false);
  const lease = runtime?.control;
  const ownsLease = Boolean(
    lease &&
    lease.actorId === data?.actorId &&
    lease.runtimeId === runtime?.runtimeId,
  );
  const leaseExpired = Boolean(lease && lease.expiresAt <= Date.now());
  const canControl = Boolean(
    ownsLease &&
    !leaseExpired &&
    lease?.state === "active" &&
    runtime?.state === "ready",
  );
  const changing =
    actions.control.isPending ||
    actions.tab.isPending ||
    actions.start.isPending ||
    actions.settings.isPending;
  const viewing = useBrowserFrame(
    sessionId,
    runtime?.runtimeId,
    selected?.id,
    Boolean(
      data?.settings.enabled &&
      runtime?.state === "ready" &&
      runtime.capabilities.viewer?.available,
    ),
  );

  useEffect(() => {
    if (addressTab.current !== selected?.id || !touchedAddress.current) {
      setAddress(selected?.url ?? "");
      touchedAddress.current = false;
    }
    addressTab.current = selected?.id;
  }, [selected?.id, selected?.url]);
  useEffect(() => {
    setChosenTab(null);
    setError(null);
  }, [sessionId, runtime?.runtimeId]);
  useEffect(() => {
    setCapture(null);
    setAnnotating(false);
  }, [sessionId]);

  async function run(operation: () => Promise<unknown>) {
    setError(null);
    try {
      await operation();
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The browser action failed. Refresh browser status before continuing.",
      );
    }
  }
  async function send(
    input: BrowserHumanInput,
    documentId = selected?.documentId,
  ): Promise<void> {
    if (!canControl || !lease || !runtime || !selected || !documentId)
      throw new Error(
        "Browser control is unavailable. Take control before interacting with the page.",
      );
    await actions.input.mutateAsync({
      leaseId: lease.id,
      runtimeId: runtime.runtimeId,
      tabId: selected.id,
      documentId,
      input,
    });
    if (
      ["navigate", "back", "forward", "reload", "dialog"].includes(input.type)
    )
      await query.refetch();
  }
  function selectTab(tabId: string) {
    setChosenTab(tabId);
    if (canControl && lease && runtime)
      void run(() =>
        actions.tab.mutateAsync({
          action: "select",
          leaseId: lease.id,
          runtimeId: runtime.runtimeId,
          tabId,
        }),
      );
  }
  async function stopActions() {
    const response =
      ownsLease && lease && !leaseExpired
        ? null
        : await actions.control.mutateAsync({ action: "take" });
    const held = response?.status?.control ?? lease;
    if (!held)
      throw new Error(
        "Browser control could not be acquired. Refresh browser status before stopping actions.",
      );
    await actions.control.mutateAsync({ action: "pause", leaseId: held.id });
  }

  if (query.isPending)
    return (
      <div className="grid flex-1 place-items-center p-6">
        <Spinner />
        <span className="text-sm text-muted">Checking browser status…</span>
      </div>
    );
  if (query.isError)
    return (
      <div role="alert" className="space-y-3 p-6 text-sm text-danger-600">
        <p>{query.error.message}</p>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void query.refetch()}
        >
          Retry browser status
        </Button>
      </div>
    );
  if (!data) return null;
  if (!data.enabled)
    return (
      <div className="grid flex-1 place-content-center gap-3 p-6 text-center text-sm text-muted">
        <Globe className="mx-auto h-6 w-6" />
        <p>This sandbox provider does not support the browser.</p>
        <p>Use a sandbox with browser support.</p>
      </div>
    );

  return (
    <section
      aria-label="Sandbox browser"
      className="flex min-h-0 flex-1 flex-col"
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-xs">
        <Globe aria-hidden className="h-4 w-4 text-moss" />
        <span role="status" className="mr-auto text-muted">
          {runtime ? STATE_LABEL[runtime.state] : "Browser has not started"}
        </span>
        {runtime?.state === "ready" && (
          <>
            <Button
              size="sm"
              variant="ghost"
              disabled={
                !data.settings.enabled ||
                !selected ||
                !runtime.capabilities.viewer?.available ||
                Boolean(lease?.privateMode) ||
                actions.capture.isPending
              }
              onClick={() =>
                void run(async () => {
                  if (!selected) return;
                  const evidence = await actions.capture.mutateAsync({
                    runtimeId: runtime.runtimeId,
                    tabId: selected.id,
                  });
                  setCapture(evidence);
                  setAnnotating(false);
                })
              }
            >
              <Camera aria-hidden className="h-3.5 w-3.5" />
              {actions.capture.isPending
                ? "Saving screenshot…"
                : "Save screenshot"}
            </Button>
            {ownsLease ? (
              <>
                {leaseExpired ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={changing}
                    onClick={() =>
                      void run(() =>
                        actions.control.mutateAsync({
                          action: "take",
                          privateMode: lease?.privateMode,
                        }),
                      )
                    }
                  >
                    Renew control
                  </Button>
                ) : lease?.state === "paused" ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={changing}
                    onClick={() =>
                      void run(() =>
                        actions.control.mutateAsync({
                          action: "resume",
                          leaseId: lease.id,
                        }),
                      )
                    }
                  >
                    Resume control
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={changing}
                  onClick={() =>
                    void run(() =>
                      actions.control.mutateAsync({
                        action: "release",
                        leaseId: lease?.id,
                      }),
                    )
                  }
                >
                  Release control
                </Button>
              </>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={changing || Boolean(lease)}
                  onClick={() =>
                    void run(() =>
                      actions.control.mutateAsync({ action: "take" }),
                    )
                  }
                >
                  Take control
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={changing || Boolean(lease)}
                  onClick={() =>
                    void run(() =>
                      actions.control.mutateAsync({
                        action: "take",
                        privateMode: true,
                      }),
                    )
                  }
                >
                  <LockKeyhole aria-hidden className="h-3.5 w-3.5" />
                  Private sign-in
                </Button>
              </>
            )}
            <Button
              size="sm"
              variant="danger"
              disabled={
                changing ||
                Boolean(lease && !ownsLease) ||
                lease?.state === "paused"
              }
              onClick={() => void run(stopActions)}
            >
              Stop browser actions
            </Button>
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-label="Refresh browser status"
          onClick={() => void query.refetch()}
        >
          <RotateCw aria-hidden className="h-3.5 w-3.5" />
        </Button>
      </div>

      {error || data.error ? (
        <div
          role="alert"
          className="shrink-0 border-b border-line bg-danger-wash px-3 py-2 text-sm text-danger-600"
        >
          {error ?? data.error}
        </div>
      ) : null}
      {lease ? (
        <div
          className={cn(
            "shrink-0 border-b border-line px-3 py-2 text-xs",
            lease.privateMode
              ? "bg-warning-wash text-warning-fg"
              : "bg-moss-wash text-ink",
          )}
        >
          {ownsLease
            ? leaseExpired
              ? "Your control lease expired. Renew control to continue, or release control to return the browser to the agent."
              : lease.privateMode
                ? "Private sign-in is active. The agent cannot observe the page. Release control when you finish."
                : lease.state === "paused"
                  ? "Browser actions are stopped. Resume control or release control when ready."
                  : "You control this browser. Agent actions are paused until you release control."
            : "Another user controls this browser. Wait for them to release control."}
        </div>
      ) : runtime?.state === "ready" ? (
        <p className="shrink-0 border-b border-line px-3 py-2 text-xs text-muted">
          Viewing the agent’s browser. Take control to interact. Private sign-in
          pauses agent observations.
        </p>
      ) : null}

      {!data.settings.enabled ? (
        <div className="grid flex-1 place-content-center gap-3 p-6 text-center text-sm text-muted">
          <p>Browser access is disabled for this session.</p>
          {data.canAdminister ? (
            <Button
              onClick={() =>
                void run(() => actions.settings.mutateAsync({ enabled: true }))
              }
              disabled={changing}
            >
              Enable browser
            </Button>
          ) : (
            <p>Ask the session owner to enable browser access.</p>
          )}
        </div>
      ) : runtime?.state !== "ready" ? (
        <div className="grid flex-1 place-content-center justify-items-center gap-3 p-6 text-center text-sm text-muted">
          {runtime?.state === "starting" ? (
            <Spinner />
          ) : (
            <Globe className="h-8 w-8" />
          )}
          <p>
            {runtime?.correctiveAction ??
              "Start the browser when you need it. Your coding session stays open."}
          </p>
          <Button
            disabled={
              changing ||
              runtime?.state === "starting" ||
              runtime?.state === "incompatible"
            }
            onClick={() => void run(() => actions.start.mutateAsync())}
          >
            {runtime?.state === "sleeping" ? "Wake browser" : "Start browser"}
          </Button>
        </div>
      ) : (
        <>
          <div
            role="tablist"
            aria-label="Browser pages"
            className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line px-2 pt-1"
          >
            {runtime.tabs.map((tab) => (
              <div key={tab.id} className="flex max-w-60 shrink-0 items-center">
                <button
                  type="button"
                  role="tab"
                  aria-selected={selected?.id === tab.id}
                  title={tab.url}
                  onClick={() => selectTab(tab.id)}
                  className={cn(
                    "max-w-48 truncate border-b-2 px-3 py-2 text-xs",
                    selected?.id === tab.id
                      ? "border-moss text-ink"
                      : "border-transparent text-muted",
                  )}
                >
                  {tab.title || tab.url || "New page"}
                </button>
                {canControl && lease ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Close ${tab.title || "page"}`}
                    disabled={changing}
                    onClick={() =>
                      void run(() =>
                        actions.tab.mutateAsync({
                          action: "close",
                          runtimeId: runtime.runtimeId,
                          leaseId: lease.id,
                          tabId: tab.id,
                        }),
                      )
                    }
                  >
                    <X aria-hidden className="h-3 w-3" />
                  </Button>
                ) : null}
              </div>
            ))}
            <Button
              size="sm"
              variant="ghost"
              aria-label="New browser page"
              disabled={!canControl || changing}
              onClick={() => {
                if (lease)
                  void run(async () => {
                    const response = await actions.tab.mutateAsync({
                      action: "new",
                      runtimeId: runtime.runtimeId,
                      leaseId: lease.id,
                      url: "about:blank",
                    });
                    setChosenTab(response.status?.selectedTabId ?? null);
                  });
              }}
            >
              <Plus aria-hidden className="h-4 w-4" />
            </Button>
          </div>
          <form
            className="flex shrink-0 items-center gap-1 border-b border-line p-2"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const url = normalizeBrowserAddress(address);
                touchedAddress.current = false;
                await send({ type: "navigate", url });
              });
            }}
          >
            <Button
              variant="ghost"
              size="sm"
              aria-label="Back"
              disabled={!canControl || !selected}
              onClick={() => void run(() => send({ type: "back" }))}
            >
              <ArrowLeft aria-hidden className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Forward"
              disabled={!canControl || !selected}
              onClick={() => void run(() => send({ type: "forward" }))}
            >
              <ArrowRight aria-hidden className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              aria-label="Reload page"
              disabled={!canControl || !selected}
              onClick={() => void run(() => send({ type: "reload" }))}
            >
              <RotateCw aria-hidden className="h-4 w-4" />
            </Button>
            <Input
              aria-label="Browser address"
              value={address}
              readOnly={!canControl}
              onChange={(event) => {
                touchedAddress.current = true;
                setAddress(event.target.value);
              }}
              className="min-w-0 flex-1 font-mono text-xs"
              placeholder="https://example.com"
            />
            <Button
              type="submit"
              size="sm"
              disabled={!canControl || !selected || !address.trim()}
            >
              Go
            </Button>
          </form>
          {runtime.dialogs
            ?.filter((dialog) => dialog.tabId === selected?.id)
            .map((dialog) => (
              <BrowserDialog
                key={dialog.dialogId}
                dialog={dialog}
                disabled={!canControl}
                send={(input) => run(() => send(input))}
              />
            ))}
          {viewing.error ? (
            <div role="alert" className="space-y-2 p-4 text-sm text-danger-600">
              <p>{viewing.error}</p>
              <Button size="sm" variant="secondary" onClick={viewing.retry}>
                Retry browser view
              </Button>
            </div>
          ) : !viewing.visible ? (
            <div className="grid flex-1 place-content-center p-6 text-sm text-muted">
              Browser viewing is paused while this page is hidden.
            </div>
          ) : viewing.frame ? (
            <BrowserViewport
              key={`${runtime.runtimeId}:${selected?.id}:${viewing.frame.documentId}:${lease?.id}:${lease?.state}`}
              frame={viewing.frame}
              canControl={canControl && !error}
              send={(input) => send(input, viewing.frame?.documentId)}
              onError={setError}
            />
          ) : (
            <div className="grid flex-1 place-content-center justify-items-center gap-2 p-6 text-sm text-muted">
              {selected && runtime.capabilities.viewer?.available ? (
                <>
                  <Spinner />
                  <p>Waiting for the browser image…</p>
                </>
              ) : (
                <p>
                  {selected
                    ? (runtime.capabilities.viewer?.reason ??
                      "This browser image does not support viewing. Use a supported browser image.")
                    : "No browser pages are open. Take control and open a page."}
                </p>
              )}
            </div>
          )}
        </>
      )}

      {capture?.sessionId === sessionId ? (
        <div className="max-h-96 shrink-0 space-y-3 overflow-auto border-t border-line p-3 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-muted">Screenshot saved:</span>
            <a
              className="text-moss underline"
              href={browserApi.evidence(sessionId, capture.id)}
              download={capture.filename}
            >
              {capture.filename}
            </a>
            <Button
              size="sm"
              variant="ghost"
              aria-expanded={annotating}
              onClick={() => setAnnotating((value) => !value)}
            >
              {annotating ? "Close annotations" : "Annotate screenshot"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Dismiss saved screenshot"
              onClick={() => setCapture(null)}
            >
              <X aria-hidden className="h-3.5 w-3.5" />
            </Button>
          </div>
          {annotating ? (
            <EvidenceAnnotations key={capture.id} evidence={capture} />
          ) : null}
        </div>
      ) : null}

      <details className="max-h-48 shrink-0 overflow-auto border-t border-line px-3 py-2 text-xs text-muted">
        <summary className="cursor-pointer">
          Browser access and capabilities
        </summary>
        <div className="space-y-3 py-3">
          {data.canAdminister ? (
            <div className="flex flex-wrap items-center gap-2">
              <span>Who can view:</span>
              <Button
                size="sm"
                variant={
                  data.settings.audience === "owner" ? "primary" : "ghost"
                }
                disabled={changing}
                onClick={() =>
                  void run(() =>
                    actions.settings.mutateAsync({ audience: "owner" }),
                  )
                }
              >
                Owner
              </Button>
              <Button
                size="sm"
                variant={
                  data.settings.audience === "team" ? "primary" : "ghost"
                }
                disabled={changing}
                onClick={() =>
                  void run(() =>
                    actions.settings.mutateAsync({ audience: "team" }),
                  )
                }
              >
                Team
              </Button>
              {data.settings.enabled ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={changing}
                  onClick={() =>
                    void run(() =>
                      actions.settings.mutateAsync({ enabled: false }),
                    )
                  }
                >
                  Disable browser access
                </Button>
              ) : null}
            </div>
          ) : (
            <p>Viewing access: {data.settings.audience}.</p>
          )}
          {data.settings.grants.map((grant) => (
            <div key={grant.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 break-all">
                {grant.origin}: {grant.operations.join(", ")}
              </span>
              {data.canAdminister ? (
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={changing}
                  onClick={() =>
                    void run(() =>
                      actions.settings.mutateAsync({
                        grants: data.settings.grants.filter(
                          (entry) => entry.id !== grant.id,
                        ),
                      }),
                    )
                  }
                >
                  Revoke
                </Button>
              ) : null}
            </div>
          ))}
          {runtime ? (
            <ul className="space-y-1">
              {Object.entries(runtime.capabilities).map(
                ([name, capability]) => (
                  <li key={name}>
                    <span className="font-medium text-ink">{name}</span>:{" "}
                    {capability.available
                      ? "Available"
                      : (capability.reason ??
                        "Unsupported in this browser image")}
                  </li>
                ),
              )}
            </ul>
          ) : null}
          {runtime?.downloads?.length ? (
            <div className="space-y-1">
              <p className="font-medium text-ink">Downloads</p>
              {runtime.downloads.map((artifact) => (
                <div key={artifact.id}>
                  <a
                    className="text-moss underline"
                    href={browserApi.download(sessionId, artifact.id)}
                    download
                  >
                    {artifact.filename}
                  </a>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </details>
    </section>
  );
}

function BrowserDialog({
  dialog,
  disabled,
  send,
}: {
  dialog: NonNullable<BrowserRuntimeStatus["dialogs"]>[number];
  disabled: boolean;
  send: (input: BrowserHumanInput) => Promise<void>;
}) {
  const [text, setText] = useState("");
  return (
    <div
      role="alertdialog"
      aria-label={`Browser ${dialog.kind}`}
      className="shrink-0 space-y-2 border-b border-line bg-warning-wash p-3 text-sm text-ink"
    >
      <p className="whitespace-pre-wrap break-words">{dialog.message}</p>
      {dialog.kind === "prompt" ? (
        <Input
          aria-label="Browser dialog response"
          value={text}
          disabled={disabled}
          onChange={(event) => setText(event.target.value)}
        />
      ) : null}
      <div className="flex gap-2">
        <Button
          size="sm"
          disabled={disabled}
          onClick={() =>
            void send({
              type: "dialog",
              dialogId: dialog.dialogId,
              accept: true,
              text,
            })
          }
        >
          Accept
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled}
          onClick={() =>
            void send({
              type: "dialog",
              dialogId: dialog.dialogId,
              accept: false,
            })
          }
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}
