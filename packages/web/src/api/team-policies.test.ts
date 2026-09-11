import { afterEach, expect, it, vi } from "vitest";
import { api } from "./client";

afterEach(() => vi.unstubAllGlobals());

it("addresses team policy endpoints with encoded team and policy IDs", async () => {
  const fetchMock = vi.fn().mockImplementation(async () => new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const body = { service: "linear", mode: "deny" as const };
  await api.listTeamPolicies("team/one");
  await api.createTeamPolicy("team/one", body);
  await api.patchTeamPolicy("team/one", "policy/two", body);
  await api.deleteTeamPolicy("team/one", "policy/two");
  expect(fetchMock.mock.calls.map(([url, options]) => [url, options.method, options.body])).toEqual([
    ["/api/teams/team%2Fone/policies", "GET", undefined],
    ["/api/teams/team%2Fone/policies", "POST", JSON.stringify(body)],
    ["/api/teams/team%2Fone/policies/policy%2Ftwo", "PATCH", JSON.stringify(body)],
    ["/api/teams/team%2Fone/policies/policy%2Ftwo", "DELETE", undefined],
  ]);
});
