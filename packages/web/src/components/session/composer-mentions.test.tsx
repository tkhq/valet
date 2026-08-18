// @vitest-environment jsdom
/**
 * The composer's `@`-mention file picker (V1 port #9).
 *
 * The requirement was that it feel identical to the slash popup beside it,
 * so these tests exercise the same contract: the popup opens on the trigger,
 * filters as the user types, navigates with the arrow keys, confirms with
 * Enter and Tab, and dismisses with Escape — and Enter confirms rather than
 * sending while it is open.
 *
 * The two path sources are stubbed at the query hooks, because what is
 * tested here is the composer's behaviour, not the fetch. Their real shapes
 * are pinned by the api tests.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useComposerPrefillStore } from "~/stores/composer-prefill";

const sendMutateAsync = vi.fn().mockResolvedValue({ messageId: "q-1", threadId: "thread-1" });

/**
 * The two mention sources, as react-query results. They are variables and
 * not literals because the states that matter are not only "here is the
 * data": both queries START DISABLED and turn on at the first `@`, so the
 * pending state is what a user actually meets on that keystroke, and a
 * failed fetch has to be distinguishable from an empty one.
 */
interface QueryLike<T> {
  data?: T;
  isLoading: boolean;
  isError: boolean;
}

type FilesChangedLike = QueryLike<{
  files: { path: string; additions: number; deletions: number; status: string; binary: boolean }[];
  additions: number;
  deletions: number;
  truncated: boolean;
}>;

type MemoryTreeLike = QueryLike<{
  entries: {
    path: string;
    title: string;
    type: string;
    pinned: boolean;
    updatedAt: number;
    dir: boolean;
    sizeBytes: number;
  }[];
}>;

const FILES_LOADED: FilesChangedLike = {
  data: {
    files: [
      { path: "src/app.ts", additions: 2, deletions: 1, status: "modified", binary: false },
      { path: "src/util/helper.ts", additions: 5, deletions: 0, status: "added", binary: false },
    ],
    additions: 7,
    deletions: 1,
    truncated: false,
  },
  isLoading: false,
  isError: false,
};

const MEMORY_LOADED: MemoryTreeLike = {
  data: {
    entries: [
      { path: "notes/hiring.md", title: "Hiring", type: "note", pinned: false, updatedAt: 1, dir: false, sizeBytes: 10 },
      { path: "notes", title: "notes", type: "dir", pinned: false, updatedAt: 1, dir: true, sizeBytes: 0 },
    ],
  },
  isLoading: false,
  isError: false,
};

const PENDING: QueryLike<never> = { isLoading: true, isError: false };
const FAILED: QueryLike<never> = { isLoading: false, isError: true };

let filesChangedResult: QueryLike<unknown> = FILES_LOADED;
let memoryTreeResult: QueryLike<unknown> = MEMORY_LOADED;

vi.mock("~/api/queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/queries")>();
  return {
    ...actual,
    useSendPrompt: () => ({ isPending: false, mutateAsync: sendMutateAsync }),
    useAbortThread: () => ({ isPending: false, mutateAsync: vi.fn(), mutate: vi.fn() }),
    useFilesChanged: () => filesChangedResult,
  };
});

vi.mock("~/api/memory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/memory")>();
  return {
    ...actual,
    useMemoryTree: () => memoryTreeResult,
  };
});

vi.mock("~/stores/stream", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/stores/stream")>();
  return {
    ...actual,
    useStreamStore: (selector: (s: Record<string, unknown>) => unknown) =>
      selector({ addUserMessage: vi.fn(() => "opt-1"), setMessageQueueItemId: vi.fn() }),
    useQueueStateForThread: () => undefined,
  };
});

vi.mock("~/hooks/use-commands", () => ({
  useCommands: () => ({ data: { commands: [{ name: "status", description: "Status", source: "builtin" }] } }),
}));

import { Composer } from "./composer";

function renderComposer() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Composer sessionId="s-1" threadId="thread-1" agentStatus="idle" />
    </QueryClientProvider>,
  );
}

function textarea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(/Send a message/i) as HTMLTextAreaElement;
}

async function type(text: string) {
  const { default: userEvent } = await import("@testing-library/user-event");
  const user = userEvent.setup();
  await user.click(textarea());
  await user.type(textarea(), text);
  return user;
}

beforeEach(() => {
  useComposerPrefillStore.setState({ text: null });
  sendMutateAsync.mockClear();
  filesChangedResult = FILES_LOADED;
  memoryTreeResult = MEMORY_LOADED;
});

describe("Composer — @ mention picker", () => {
  it("stays closed until an @ is typed", async () => {
    renderComposer();
    await type("look at the file");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("opens on a bare @ and lists both sources", async () => {
    renderComposer();
    await type("look at @");
    const options = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(options.some((t) => t.includes("src/app.ts"))).toBe(true);
    expect(options.some((t) => t.includes("notes/hiring.md"))).toBe(true);
  });

  it("leaves memory directory rows out — a directory is not a document", async () => {
    renderComposer();
    await type("@");
    const options = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    // "notes/hiring.md" is present; the bare "notes" directory row is not.
    expect(options.some((t) => t.trim() === "notes")).toBe(false);
  });

  it("filters as the user types", async () => {
    renderComposer();
    await type("@helper");
    const options = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(options).toHaveLength(1);
    expect(options[0]).toContain("src/util/helper.ts");
  });

  it("does not open inside an email address", async () => {
    renderComposer();
    await type("mail someone@example");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("inserts the chosen path with Enter and does not send", async () => {
    renderComposer();
    const user = await type("please read @helper");
    await user.keyboard("{Enter}");
    expect(textarea().value).toBe("please read @src/util/helper.ts ");
    expect(sendMutateAsync).not.toHaveBeenCalled();
  });

  it("inserts the chosen path with Tab", async () => {
    renderComposer();
    const user = await type("@helper");
    await user.keyboard("{Tab}");
    expect(textarea().value).toBe("@src/util/helper.ts ");
  });

  it("moves the selection with the arrow keys", async () => {
    renderComposer();
    const user = await type("@src");
    await user.keyboard("{ArrowDown}{Enter}");
    expect(textarea().value).toBe("@src/util/helper.ts ");
  });

  it("closes on Escape without changing the text", async () => {
    renderComposer();
    const user = await type("@helper");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(textarea().value).toBe("@helper");
  });

  it("sends normally once the mention is complete and the caret has moved on", async () => {
    renderComposer();
    const user = await type("read @helper");
    await user.keyboard("{Enter}");
    // The mention is inserted and the popup is closed; the next Enter sends.
    await user.keyboard("{Enter}");
    expect(sendMutateAsync).toHaveBeenCalledTimes(1);
    expect(sendMutateAsync.mock.calls[0]?.[0]).toMatchObject({
      text: "read @src/util/helper.ts",
    });
  });

  it("says so when nothing matches, rather than showing an empty popup", async () => {
    renderComposer();
    await type("@zzzznotafile");
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByText(/No file matches/i)).toBeTruthy();
  });

  it("keeps the slash popup working — an @ does not shadow a command", async () => {
    renderComposer();
    await type("/stat");
    const options = screen.getAllByRole("option").map((o) => o.textContent ?? "");
    expect(options.some((t) => t.includes("/status"))).toBe(true);
  });
});

describe("Composer — @ mention picker before its sources have loaded", () => {
  it("does not claim the session has nothing while the sources are still loading", async () => {
    // The first `@` a user ever types is exactly this state: both queries
    // were disabled until that keystroke, so they are in flight. Telling
    // the user "this session has no repository changes and no memory
    // documents" here is a statement about the session that nothing has
    // checked, and it is wrong on any session that has either.
    filesChangedResult = PENDING;
    memoryTreeResult = PENDING;
    renderComposer();
    await type("@");
    expect(screen.queryByText(/no repository changes/i)).toBeNull();
    expect(screen.getByText(/Loading file suggestions/i)).toBeTruthy();
  });

  it("does not claim the session has nothing when one source is still loading", async () => {
    filesChangedResult = PENDING;
    renderComposer();
    await type("@");
    expect(screen.queryByText(/no repository changes/i)).toBeNull();
  });

  it("says the suggestions failed rather than that none exist", async () => {
    filesChangedResult = FAILED;
    memoryTreeResult = FAILED;
    renderComposer();
    await type("@");
    expect(screen.queryByText(/no repository changes/i)).toBeNull();
    // Names the action, so the user is not stuck at a dead popup.
    expect(screen.getByText(/Could not load file suggestions. Type the path instead./i)).toBeTruthy();
  });

  it("still says the session has nothing once both sources have settled empty", async () => {
    filesChangedResult = { data: { files: [], additions: 0, deletions: 0, truncated: false }, isLoading: false, isError: false };
    memoryTreeResult = { data: { entries: [] }, isLoading: false, isError: false };
    renderComposer();
    await type("@");
    expect(screen.getByText(/no repository changes and no memory documents/i)).toBeTruthy();
  });
});
