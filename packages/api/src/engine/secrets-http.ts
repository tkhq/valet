/**
 * `valet-secrets http`: one HTTPS call with a use-only secret, made by the
 * secret use service (broker design, "Using a secret without exporting it").
 *
 *   valet-secrets http POST https://api.example.com/v1/x \
 *     -H 'Authorization: Bearer {{secret://personal/EXAMPLE_KEY}}' -d @body.json
 *
 * One header holds a `{{secret://...}}` placeholder. This program removes that
 * header, sends the reference, the header name and the rest of the request to
 * `POST /api/sandbox-secrets/use`, prints the response body on stdout and one
 * line on stderr, for example
 * `HTTP 200: EXAMPLE_KEY POST api.example.com/v1/x, signed by use service`.
 * The thread shows that line with the command. The value never reaches the
 * sandbox.
 *
 * Input: argv after `--`, and `VALET_HTTP_API` / `VALET_HTTP_TOKEN` in the
 * environment, which it deletes before anything else.
 *
 * The body is `String.raw` with no `${` and no backtick, and the shell embeds
 * it in single quotes, so it must never contain a single quote:
 * `secretsCliScript` refuses one.
 */
export const HTTP_JS = String.raw`"use strict";
const fs = require("node:fs");
const api = process.env.VALET_HTTP_API || "";
const token = process.env.VALET_HTTP_TOKEN || "";
delete process.env.VALET_HTTP_API;
delete process.env.VALET_HTTP_TOKEN;
function fail(msg, code) { process.stderr.write("valet-secrets: " + msg + "\n"); process.exit(code); }
const usage = "usage: valet-secrets http METHOD URL [-H \"Name: value\"]... [-d DATA | -d @FILE]\n" +
  "Put {{secret://scope/NAME}} in exactly one header, for example:\n" +
  "  valet-secrets http GET https://api.example.com/v1/me -H \"Authorization: Bearer {{secret://personal/EXAMPLE_KEY}}\"";
const args = process.argv.slice(1);
if (args.length < 2) fail(usage, 2);
const method = args[0].toUpperCase();
const url = args[1];
const headers = {};
let body = Buffer.alloc(0);
for (let i = 2; i < args.length; i++) {
  const a = args[i];
  if ((a === "-H" || a === "--header") && i + 1 < args.length) {
    const h = args[++i];
    const at = h.indexOf(":");
    if (at < 1) fail("header must look like \"Name: value\", got: " + h, 2);
    headers[h.slice(0, at).trim().toLowerCase()] = h.slice(at + 1).trim();
  } else if ((a === "-d" || a === "--data" || a === "--data-binary") && i + 1 < args.length) {
    const d = args[++i];
    try { body = d.startsWith("@") ? fs.readFileSync(d.slice(1)) : Buffer.from(d, "utf8"); }
    catch (e) { fail("could not read " + d.slice(1) + ": " + e.message, 2); }
  } else {
    fail(usage, 2);
  }
}
const placeholder = /\{\{\s*(secret:\/\/[^}\s]+)\s*\}\}/;
const withSecret = Object.keys(headers).filter((k) => placeholder.test(headers[k]));
if (withSecret.length !== 1) fail("put {{secret://scope/NAME}} in exactly one header.\n" + usage, 2);
const header = withSecret[0];
const reference = headers[header].match(placeholder)[1];
delete headers[header];
for (const k of Object.keys(headers)) {
  if (headers[k].includes("{{")) fail("only one header can hold a placeholder, and no other text can: " + k, 2);
}
(async () => {
  let res;
  try {
    res = await fetch(api + "/api/sandbox-secrets/use", {
      method: "POST",
      headers: { "content-type": "application/json", "x-valet-sandbox": token },
      body: JSON.stringify({ reference, header, request: { method, url, headers, body: body.toString("base64") } }),
      signal: AbortSignal.timeout(90000),
    });
  } catch (e) {
    fail("could not reach the broker at " + api + ". Check that the api is running and reachable from this sandbox, then run again.", 4);
  }
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch (e) { /* reported below */ }
  if (!res.ok) fail(json.error || ("the broker answered HTTP " + res.status + ". Check the api logs, then run again."), 4);
  // One line per use: what went where, the answer, and who signed the receipt.
  let where = url;
  try { const u = new URL(url); where = u.host + u.pathname; } catch (e) { /* keep the URL as given */ }
  process.stderr.write("HTTP " + json.status + ": " + (json.secret || reference) + " " + method + " " + where + ", signed by " + (json.signer || "use service") + "\n");
  const loc = (json.headers || []).find((h) => h[0] === "location");
  if (loc) process.stderr.write("location: " + loc[1] + " (not followed: run again with that URL if the secret may go there)\n");
  process.stdout.write(Buffer.from(json.body || "", "base64"));
})();
`;
