import { useEffect, useRef, useState } from "react";
import { parseResourceQuantity } from "@valet/shared";
import type { SourceSummary } from "~/api/sources";
import { usePatchSource } from "~/api/sources";
import { ApiError } from "~/api/client";
import { Button, Input, Label } from "~/components/primitives";

type SandboxResources = NonNullable<SourceSummary["sandboxResources"]>;

function cpuText(resources: SourceSummary["sandboxResources"]): string {
  return resources?.cpu?.toString() ?? "";
}

function memoryText(resources: SourceSummary["sandboxResources"]): string {
  return resources?.memory ?? "";
}

function serverSaveError(error: Error): string {
  if (error instanceof ApiError && typeof error.payload === "object" && error.payload !== null) {
    const payload = error.payload as { error?: string };
    if (typeof payload.error === "string") return payload.error;
  }
  return "Resources were not saved. Check the values and try again.";
}

export function RepoSandboxResourcesForm({ source }: { source: SourceSummary }) {
  const patchSource = usePatchSource();
  const repositoryName = source.repoFullName ?? source.name;
  const cpuId = `repo-${source.id}-sandbox-cpu`;
  const memoryId = `repo-${source.id}-sandbox-memory`;
  const cpuErrorId = `${cpuId}-error`;
  const memoryErrorId = `${memoryId}-error`;

  const propCpu = cpuText(source.sandboxResources);
  const propMemory = memoryText(source.sandboxResources);
  const [cpu, setCpu] = useState(propCpu);
  const [memory, setMemory] = useState(propMemory);
  const [saveError, setSaveError] = useState<string | null>(null);
  const cpuTouched = useRef(false);
  const memoryTouched = useRef(false);
  const awaitingUpdatedAt = useRef<number | null>(null);

  useEffect(() => {
    if (awaitingUpdatedAt.current !== null) {
      if (source.updatedAt < awaitingUpdatedAt.current) return;
      awaitingUpdatedAt.current = null;
    }
    if (!cpuTouched.current) setCpu(propCpu);
    if (!memoryTouched.current) setMemory(propMemory);
  }, [propCpu, propMemory, source.updatedAt]);

  const trimmedCpu = cpu.trim();
  const trimmedMemory = memory.trim();
  const cpuValue = Number(trimmedCpu);
  const cpuValid =
    trimmedCpu === "" ||
    (/^\+?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmedCpu) &&
      Number.isFinite(cpuValue) &&
      cpuValue > 0);
  const parsedMemory = trimmedMemory === "" ? null : parseResourceQuantity(trimmedMemory);
  const memoryValid = trimmedMemory === "" || (parsedMemory !== null && parsedMemory > 0);

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!cpuValid || !memoryValid) return;
    setSaveError(null);

    const sandboxResources: SandboxResources = {};
    if (trimmedCpu !== "") sandboxResources.cpu = cpuValue;
    if (trimmedMemory !== "") sandboxResources.memory = trimmedMemory;
    const bodyResources = Object.keys(sandboxResources).length > 0 ? sandboxResources : null;

    patchSource.mutate(
      { id: source.id, body: { sandboxResources: bodyResources } },
      {
        onSuccess: (data) => {
          const savedResources = data.source.sandboxResources;
          awaitingUpdatedAt.current = data.source.updatedAt;
          cpuTouched.current = false;
          memoryTouched.current = false;
          setCpu(cpuText(savedResources));
          setMemory(memoryText(savedResources));
          setSaveError(null);
        },
        onError: (error) => setSaveError(serverSaveError(error)),
      },
    );
  }

  return (
    <form onSubmit={handleSubmit} className="rounded border border-line bg-ink-wash p-3">
      <fieldset className="space-y-3" disabled={patchSource.isPending}>
        <legend className="text-xs font-medium text-ink">
          Sandbox resources for {repositoryName}
        </legend>
        <p className="text-xs text-muted">
          .valet/prebuild.yaml values override these saved values. An empty field clears its saved value.
          Valet then uses YAML or the deployment default.
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={cpuId}>CPU cores (optional)</Label>
            <Input
              id={cpuId}
              aria-label={`CPU cores for ${repositoryName}`}
              aria-describedby={!cpuValid ? cpuErrorId : undefined}
              aria-invalid={!cpuValid}
              inputMode="decimal"
              value={cpu}
              disabled={patchSource.isPending}
              placeholder="Deployment default"
              onChange={(event) => {
                cpuTouched.current = true;
                setCpu(event.target.value);
              }}
            />
            {!cpuValid && (
              <p id={cpuErrorId} className="text-xs text-danger-500">
                Enter a positive CPU value, such as 2 or 0.5.
              </p>
            )}
          </div>

          <div className="space-y-1">
            <Label htmlFor={memoryId}>Memory (optional)</Label>
            <Input
              id={memoryId}
              aria-label={`Memory for ${repositoryName}`}
              aria-describedby={!memoryValid ? memoryErrorId : undefined}
              aria-invalid={!memoryValid}
              value={memory}
              disabled={patchSource.isPending}
              placeholder="Deployment default"
              onChange={(event) => {
                memoryTouched.current = true;
                setMemory(event.target.value);
              }}
            />
            {!memoryValid && (
              <p id={memoryErrorId} className="text-xs text-danger-500">
                Enter a positive Kubernetes memory quantity, such as 8Gi or 500Mi.
              </p>
            )}
          </div>
        </div>

        <p className="text-xs text-muted">
          Changes apply before the next run and can restart compute. The working directory persists.
        </p>
        {saveError && <p className="text-xs text-danger-500">{saveError}</p>}
        <Button type="submit" size="sm" disabled={!cpuValid || !memoryValid || patchSource.isPending}>
          {patchSource.isPending ? "Saving resources…" : "Save resources"}
        </Button>
      </fieldset>
    </form>
  );
}
