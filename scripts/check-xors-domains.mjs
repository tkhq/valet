import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// These are aliases for one XORS installation. Check both after each deploy.
const domains = ["valet.xors.xyz", "valet.xors.dev"];

async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  assert(response.ok, `${url}: HTTP ${response.status}`);
  return response;
}

const releases = await Promise.all(domains.map(async (domain) => {
  const origin = `https://${domain}`;
  const health = await (await get(`${origin}/api/health`)).json();
  assert.equal(health.ok, true, `${domain}: API is not healthy`);
  assert.equal(health.service, "valet-api", `${domain}: unexpected service`);
  const html = await (await get(origin)).text();
  const entry = html.match(/<script\b[^>]*\bsrc="(\/assets\/[^"\s]+\.js)"/);
  assert(entry, `${domain}: frontend entry is missing`);
  const bundle = await (await get(new URL(entry[1], origin))).arrayBuffer();
  const hash = createHash("sha256").update(Buffer.from(bundle)).digest("hex");
  console.log(`${domain}: healthy, frontend ${entry[1]}, sha256 ${hash}`);
  return { entry: entry[1], hash };
}));

assert.deepEqual(releases[0], releases[1], "XORS domains serve different frontend releases");
