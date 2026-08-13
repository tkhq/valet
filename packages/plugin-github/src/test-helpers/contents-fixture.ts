/**
 * Fake GitHub contents API on a real HTTP port, for tests that drive a real
 * `Octokit` (constructed with `baseUrl`) instead of a stub. Only
 * `GET /repos/:owner/:repo/contents/*` is served — that one endpoint backs
 * both `github.read_repo_file` and `github.list_repo_directory`.
 *
 * The handler receives the parsed query, so a test can serve real pages
 * keyed on `?page=`. The fixture sends NO `Link` header on purpose: the
 * page loop under test must work without one.
 *
 * Callers MUST `await close()` — nothing else stops the listener.
 */
import { createServer, type Server } from "node:http";

export interface ContentsFixtureCall {
  /** Request path with the query string removed. */
  path: string;
  query: Record<string, string>;
}

export interface ContentsFixtureResponse {
  status?: number;
  body: unknown;
}

export type ContentsFixtureHandler = (call: ContentsFixtureCall) => ContentsFixtureResponse;

export interface ContentsFixture {
  url: string;
  calls: ContentsFixtureCall[];
  close(): Promise<void>;
}

function port(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port assigned");
  return address.port;
}

export async function startContentsFixture(
  handler: ContentsFixtureHandler,
): Promise<ContentsFixture> {
  const calls: ContentsFixtureCall[] = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) query[key] = value;

    const call: ContentsFixtureCall = { path: url.pathname, query };
    calls.push(call);

    const { status, body } = handler(call);
    res.writeHead(status ?? 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    url: `http://127.0.0.1:${port(server)}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
