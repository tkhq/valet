import { describe, expect, it, vi } from "vitest";
import { ResourceAuthorizationError, type ResourceAuthorizationPort } from "../authorization/resource-authorization.js";
import { listAuthorizedRepos, type RepoHost, type RepoHostContext } from "./host.js";

const context = { organizationId: "org-1", actorUserId: "user-1", principal: { type: "user" as const, id: "user-1" }, deliveryId: "delivery-1" };
const hostContext = { orgId: "org-1", userId: "user-1", deps: {} } as RepoHostContext;

describe("repository resource authorization", () => {
  it("does not access the repository host when policy denies", async () => {
    const listRepos = vi.fn<RepoHost["listRepos"]>();
    const host: RepoHost = { id: "test", listRepos, resolveGitToken: async () => null };
    const port: ResourceAuthorizationPort = { authorize: async () => { throw new ResourceAuthorizationError("deny"); } };
    await expect(listAuthorizedRepos(host, hostContext, { port, context })).rejects.toThrow(ResourceAuthorizationError);
    expect(listRepos).not.toHaveBeenCalled();
  });

  it("applies the descriptor result limit after authorization", async () => {
    const rows = [{ id: 1, name: "one", fullName: "o/one", url: "u", cloneUrl: "c", defaultBranch: "main", private: false, description: null, language: null }, { id: 2, name: "two", fullName: "o/two", url: "u", cloneUrl: "c", defaultBranch: "main", private: false, description: null, language: null }];
    const host: RepoHost = { id: "test", listRepos: async () => rows, resolveGitToken: async () => null };
    const port: ResourceAuthorizationPort = { authorize: async () => ({ schemaVersion: 1, readOnly: false, resultLimit: 1, redactions: [] }) };
    await expect(listAuthorizedRepos(host, hostContext, { port, context })).resolves.toEqual([rows[0]]);
  });
});
