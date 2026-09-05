// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SourceSummary } from "~/api/sources";

const patchMutate = vi.fn();
let patchPending = false;

vi.mock("~/api/sources", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/sources")>();
  return {
    ...actual,
    usePatchSource: () => ({ mutate: patchMutate, isPending: patchPending }),
  };
});

import { RepoSandboxResourcesForm } from "./repo-sandbox-resources-form";

function makeSource(overrides: Partial<SourceSummary> = {}): SourceSummary {
  return {
    id: "src_1",
    orgId: "org_1",
    kind: "repo",
    parentId: null,
    name: "acme/widgets",
    externalRef: null,
    pullSecretName: null,
    setupCommands: null,
    repoHost: "github",
    repoFullName: "acme/widgets",
    cloneUrl: "https://github.com/acme/widgets.git",
    sandboxResources: null,
    schedule: "nightly",
    enabled: true,
    lastBoundAt: Date.now(),
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe("RepoSandboxResourcesForm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    patchPending = false;
  });

  it("saves CPU and memory defaults", async () => {
    const user = userEvent.setup();
    render(<RepoSandboxResourcesForm source={makeSource()} />);

    await user.type(screen.getByLabelText("CPU cores for acme/widgets"), "4");
    await user.type(screen.getByLabelText("Memory for acme/widgets"), "8Gi");
    await user.click(screen.getByRole("button", { name: "Save resources" }));

    expect(patchMutate).toHaveBeenCalledWith(
      { id: "src_1", body: { sandboxResources: { cpu: 4, memory: "8Gi" } } },
      expect.anything(),
    );
  });

  it("clears all saved resource defaults with null", async () => {
    const user = userEvent.setup();
    render(
      <RepoSandboxResourcesForm
        source={makeSource({ sandboxResources: { cpu: 2, memory: "4Gi" } })}
      />,
    );

    await user.clear(screen.getByLabelText("CPU cores for acme/widgets"));
    await user.clear(screen.getByLabelText("Memory for acme/widgets"));
    await user.click(screen.getByRole("button", { name: "Save resources" }));

    expect(patchMutate).toHaveBeenCalledWith(
      { id: "src_1", body: { sandboxResources: null } },
      expect.anything(),
    );
  });

  it("clears one saved field without clearing the other field", async () => {
    const user = userEvent.setup();
    render(
      <RepoSandboxResourcesForm
        source={makeSource({ sandboxResources: { cpu: 2, memory: "4Gi" } })}
      />,
    );

    await user.clear(screen.getByLabelText("CPU cores for acme/widgets"));
    await user.click(screen.getByRole("button", { name: "Save resources" }));

    expect(patchMutate).toHaveBeenCalledWith(
      { id: "src_1", body: { sandboxResources: { memory: "4Gi" } } },
      expect.anything(),
    );
  });

  it("keeps a stored small CPU valid during a memory-only edit", async () => {
    const user = userEvent.setup();
    render(
      <RepoSandboxResourcesForm
        source={makeSource({ sandboxResources: { cpu: 0.0000001, memory: "4Gi" } })}
      />,
    );

    await user.clear(screen.getByLabelText("Memory for acme/widgets"));
    await user.type(screen.getByLabelText("Memory for acme/widgets"), "8Gi");
    await user.click(screen.getByRole("button", { name: "Save resources" }));

    expect(patchMutate).toHaveBeenCalledWith(
      { id: "src_1", body: { sandboxResources: { cpu: 1e-7, memory: "8Gi" } } },
      expect.anything(),
    );
  });

  it.each(["0", "-1", "not-a-number"])("rejects invalid CPU value %s", async (cpu) => {
    const user = userEvent.setup();
    render(<RepoSandboxResourcesForm source={makeSource()} />);

    await user.type(screen.getByLabelText("CPU cores for acme/widgets"), cpu);

    expect(screen.getByText("Enter a positive CPU value, such as 2 or 0.5.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save resources" }) as HTMLButtonElement).disabled).toBe(true);
    expect(patchMutate).not.toHaveBeenCalled();
  });

  it.each(["0", "-1Gi", "eight"])("rejects invalid memory value %s", async (memory) => {
    const user = userEvent.setup();
    render(<RepoSandboxResourcesForm source={makeSource()} />);

    await user.type(screen.getByLabelText("Memory for acme/widgets"), memory);

    expect(
      screen.getByText("Enter a positive Kubernetes memory quantity, such as 8Gi or 500Mi."),
    ).toBeTruthy();
    expect((screen.getByRole("button", { name: "Save resources" }) as HTMLButtonElement).disabled).toBe(true);
    expect(patchMutate).not.toHaveBeenCalled();
  });

  it("keeps entered values and shows an actionable save error", async () => {
    const user = userEvent.setup();
    render(<RepoSandboxResourcesForm source={makeSource()} />);
    const cpu = screen.getByLabelText("CPU cores for acme/widgets");
    const memory = screen.getByLabelText("Memory for acme/widgets");

    await user.type(cpu, "4");
    await user.type(memory, "8Gi");
    await user.click(screen.getByRole("button", { name: "Save resources" }));
    act(() => patchMutate.mock.calls[0][1].onError(new Error("Request failed")));

    expect((cpu as HTMLInputElement).value).toBe("4");
    expect((memory as HTMLInputElement).value).toBe("8Gi");
    expect(screen.getByText("Resources were not saved. Check the values and try again.")).toBeTruthy();
  });

  it("refreshes untouched fields without replacing a dirty field", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <RepoSandboxResourcesForm
        source={makeSource({ sandboxResources: { cpu: 2, memory: "4Gi" } })}
      />,
    );
    await user.clear(screen.getByLabelText("CPU cores for acme/widgets"));
    await user.type(screen.getByLabelText("CPU cores for acme/widgets"), "3");

    rerender(
      <RepoSandboxResourcesForm
        source={makeSource({ sandboxResources: { cpu: 6, memory: "12Gi" } })}
      />,
    );

    expect((screen.getByLabelText("CPU cores for acme/widgets") as HTMLInputElement).value).toBe("3");
    expect((screen.getByLabelText("Memory for acme/widgets") as HTMLInputElement).value).toBe("12Gi");
  });

  it("uses the mutation response until the refreshed query contains it", async () => {
    const user = userEvent.setup();
    const original = makeSource({ sandboxResources: { cpu: 2, memory: "4Gi" } });
    const { rerender } = render(<RepoSandboxResourcesForm source={original} />);
    const cpu = screen.getByLabelText("CPU cores for acme/widgets");

    await user.clear(cpu);
    await user.type(cpu, "4");
    await user.click(screen.getByRole("button", { name: "Save resources" }));
    act(() => patchMutate.mock.calls[0][1].onSuccess({
      source: makeSource({ sandboxResources: { cpu: 4, memory: "4Gi" }, updatedAt: 2000 }),
    }));

    rerender(
      <RepoSandboxResourcesForm
        source={makeSource({ sandboxResources: { cpu: 3, memory: "4Gi" }, updatedAt: 1000 })}
      />,
    );
    expect((cpu as HTMLInputElement).value).toBe("4");

    rerender(
      <RepoSandboxResourcesForm
        source={makeSource({ sandboxResources: { cpu: 4, memory: "4Gi" }, updatedAt: 2000 })}
      />,
    );
    expect((cpu as HTMLInputElement).value).toBe("4");
  });

  it("accepts a newer administrator update before the saved query value appears", async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <RepoSandboxResourcesForm
        source={makeSource({ sandboxResources: { cpu: 2, memory: "4Gi" }, updatedAt: 1000 })}
      />,
    );
    const cpu = screen.getByLabelText("CPU cores for acme/widgets");

    await user.clear(cpu);
    await user.type(cpu, "4");
    await user.click(screen.getByRole("button", { name: "Save resources" }));
    act(() => patchMutate.mock.calls[0][1].onSuccess({
      source: makeSource({ sandboxResources: { cpu: 4, memory: "4Gi" }, updatedAt: 2000 }),
    }));

    rerender(
      <RepoSandboxResourcesForm
        source={makeSource({ sandboxResources: { cpu: 6, memory: "4Gi" }, updatedAt: 3000 })}
      />,
    );

    expect((cpu as HTMLInputElement).value).toBe("6");
  });

  it("disables all controls while the save is pending", () => {
    patchPending = true;
    render(<RepoSandboxResourcesForm source={makeSource()} />);

    expect((screen.getByLabelText("CPU cores for acme/widgets") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Memory for acme/widgets") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Saving resources…" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
