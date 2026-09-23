import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { gitPushOperations } from "../schema/index.js";
import {
  completeSignedPushReconciliation,
  replaySignedCommits,
  type GitHubCreatedCommit,
  type GitHubReplayClient,
} from "./git-attribution.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

function replayClient(initialHead: string, options: { failAfterPublish?: boolean } = {}) {
  let remoteHead = initialHead;
  let commitNumber = 0;
  let failAfterPublish = options.failAfterPublish ?? false;
  const commits = new Map<string, GitHubCreatedCommit>();
  const client: GitHubReplayClient = {
    refresh: async () => {},
    createCommit: async ({ message, tree, parents }) => {
      commitNumber += 1;
      const commit: GitHubCreatedCommit = {
        sha: `signed-${commitNumber}`,
        message,
        tree: { sha: tree },
        parents: parents.map((sha) => ({ sha })),
        author: { name: "valet[bot]" },
        committer: { name: "GitHub" },
        verification: { verified: true },
      };
      commits.set(commit.sha, commit);
      return commit;
    },
    getCommit: async (sha) => commits.get(sha)!,
    getRef: async () => {
      if (failAfterPublish && remoteHead.startsWith("signed-")) {
        failAfterPublish = false;
        throw new Error("connection lost after publish");
      }
      return remoteHead;
    },
    createRef: async (_ref, sha) => { remoteHead = sha; },
    updateRef: async (_ref, sha) => { remoteHead = sha; },
  };
  return { client, remote: () => remoteHead };
}

const firstPush = {
  sessionId: "session-a",
  generation: 1,
  repoFullName: "acme/widgets",
  targetRef: "refs/heads/feature",
  expectedRemoteSha: "remote-0",
  commits: [{ localSha: "local-1", message: "First\n", treeSha: "tree-1", parents: ["remote-0"] }],
};

describe("signed push crash recovery and convergence", () => {
  it("authorizes reconciliation, completes idempotently, and signs a second push", async () => {
    api = await bootTestApi();
    const replay = replayClient("remote-0");

    const first = await replaySignedCommits(api.providers.db, replay.client, firstPush);
    expect(replay.remote()).toBe("signed-1");
    await expect(completeSignedPushReconciliation(api.providers.db, {
      operationId: first.operationId,
      sessionId: "another-session",
    })).rejects.toThrow(/not ready/u);
    await expect(completeSignedPushReconciliation(api.providers.db, {
      operationId: first.operationId,
      sessionId: firstPush.sessionId,
    })).resolves.toEqual({ signedHeadSha: "signed-1" });
    await expect(replaySignedCommits(api.providers.db, replay.client, firstPush)).resolves.toEqual(first);

    const second = await replaySignedCommits(api.providers.db, replay.client, {
      ...firstPush,
      expectedRemoteSha: "signed-1",
      commits: [{ localSha: "local-2", message: "Second\n", treeSha: "tree-2", parents: ["signed-1"] }],
    });
    expect(second.signedHeadSha).toBe("signed-2");
    expect(replay.remote()).toBe("signed-2");
  });

  it("recovers when publication succeeds before the response is persisted", async () => {
    api = await bootTestApi();
    const replay = replayClient("remote-0", { failAfterPublish: true });

    await expect(replaySignedCommits(api.providers.db, replay.client, firstPush)).rejects.toThrow(/connection lost/u);
    const failed = (await api.providers.db.select().from(gitPushOperations))[0];
    expect(failed.state).toBe("failed");
    expect(failed.signedHeadSha).toBe("signed-1");

    const recovered = await replaySignedCommits(api.providers.db, replay.client, {
      ...firstPush,
      expectedRemoteSha: "signed-1",
    });
    expect(recovered.signedHeadSha).toBe("signed-1");
    const row = (await api.providers.db.select().from(gitPushOperations)
      .where(eq(gitPushOperations.id, recovered.operationId)))[0];
    expect(row.state).toBe("reconciling");
  });
});
