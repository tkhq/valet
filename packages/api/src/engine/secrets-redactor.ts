/**
 * The output filter `valet-secrets run` starts its command under.
 *
 * `valet-secrets run` places resolved values in a command's environment. If
 * the command prints one, for example a debug line or an error that echoes a
 * request header, the value reaches the tool result, the model and the saved
 * transcript. This Node program runs the command with piped stdout and
 * stderr and replaces each value with `[secret:NAME]` before the output
 * leaves the sandbox.
 *
 * Limits, stated where the filter lives:
 * - It matches the exact bytes and the whole value encoded as base64,
 *   base64url, hex, or percent-encoding. Any other encoding (JSON escaping,
 *   a base64 of a longer string that contains the value, `od`) passes through.
 * - Values shorter than 8 bytes are not matched: a short value also occurs in
 *   ordinary output, and replacing it would corrupt that output.
 * - It catches accidents. A command written to leak a value can still leak it
 *   by encoding it or writing it to a file.
 *
 * Input: `VALET_SECRETS_REDACT`, one `NAME base64` pair per line. The filter
 * deletes it from its own environment before it starts the command.
 *
 * The body is `String.raw` with no `${` and no backtick, so the template
 * interprets nothing. The shell script embeds it in single quotes, so the
 * body must never contain a single quote: `secretsCliScript` refuses one.
 */
export const REDACTOR_JS = String.raw`"use strict";
const { spawn } = require("node:child_process");
const MIN_BYTES = 8;
const raw = process.env.VALET_SECRETS_REDACT || "";
delete process.env.VALET_SECRETS_REDACT;
const secrets = [];
const seen = new Set();
// The value and the encodings a command most often prints it in: base64
// (padded and not), base64url, hex in either case, and percent-encoding.
// Only an encoding of the whole value matches, from its first byte.
function encodedForms(bytes) {
  const text = bytes.toString("utf8");
  const b64 = bytes.toString("base64");
  const hex = bytes.toString("hex");
  const forms = [bytes, Buffer.from(b64), Buffer.from(b64.replace(/=+$/, "")), Buffer.from(bytes.toString("base64url")), Buffer.from(hex), Buffer.from(hex.toUpperCase())];
  const pct = encodeURIComponent(text);
  if (pct !== text) forms.push(Buffer.from(pct));
  return forms;
}
for (const line of raw.split("\n")) {
  const space = line.indexOf(" ");
  if (space < 1) continue;
  const mark = Buffer.from("[secret:" + line.slice(0, space) + "]");
  const value = Buffer.from(line.slice(space + 1), "base64");
  let end = value.length;
  while (end > 0 && (value[end - 1] === 10 || value[end - 1] === 13)) end--;
  // A value saved from a file often ends in a newline that the command does
  // not print. Match the value with and without it.
  for (const bytes of end < value.length ? [value, value.subarray(0, end)] : [value]) {
    if (bytes.length < MIN_BYTES) continue;
    for (const form of encodedForms(bytes)) {
      const key = form.toString("latin1");
      if (seen.has(key)) continue;
      seen.add(key);
      secrets.push({ bytes: form, mark });
    }
  }
}
// Longest first, so a value that contains another value wins.
secrets.sort((a, b) => b.bytes.length - a.bytes.length);
const firstBytes = new Set(secrets.map((s) => s.bytes[0]));

// Returns the parts to write and the tail to keep. A tail is kept only while
// it could still become a value; at the end of the stream nothing is kept.
function scan(buf, final) {
  const parts = [];
  let start = 0;
  let i = 0;
  scanning: while (i < buf.length) {
    if (firstBytes.has(buf[i])) {
      let partial = null;
      for (const s of secrets) {
        const n = Math.min(s.bytes.length, buf.length - i);
        if (buf.compare(s.bytes, 0, n, i, i + n) !== 0) continue;
        if (n < s.bytes.length) {
          partial = partial || s;
          continue;
        }
        if (partial && !final) break;
        parts.push(buf.subarray(start, i), s.mark);
        i += n;
        start = i;
        continue scanning;
      }
      if (partial && !final) {
        parts.push(buf.subarray(start, i));
        return { parts, rest: buf.subarray(i) };
      }
      if (partial && buf.length - i >= MIN_BYTES) {
        // The stream ended inside a value. Do not print its first bytes.
        parts.push(buf.subarray(start, i), partial.mark);
        return { parts, rest: Buffer.alloc(0) };
      }
    }
    i++;
  }
  parts.push(buf.subarray(start));
  return { parts, rest: Buffer.alloc(0) };
}

function pipeRedacted(source, sink) {
  let rest = Buffer.alloc(0);
  let broken = false;
  // A closed reader (for example "| head") must not crash the filter.
  sink.on("error", () => {
    broken = true;
  });
  const emit = (parts) => {
    for (const part of parts) {
      if (part.length === 0 || broken) continue;
      if (!sink.write(part)) {
        source.pause();
        sink.once("drain", () => source.resume());
      }
    }
  };
  source.on("data", (chunk) => {
    const out = scan(rest.length ? Buffer.concat([rest, chunk]) : chunk, false);
    rest = out.rest;
    emit(out.parts);
  });
  source.on("end", () => {
    emit(scan(rest, true).parts);
    rest = Buffer.alloc(0);
  });
}

const [command, ...args] = process.argv.slice(1);
const piped = secrets.length > 0;
const child = spawn(command, args, { stdio: ["inherit", piped ? "pipe" : "inherit", piped ? "pipe" : "inherit"] });
if (piped) {
  pipeRedacted(child.stdout, process.stdout);
  pipeRedacted(child.stderr, process.stderr);
}
const forwarded = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"];
const forward = (signal) => child.kill(signal);
for (const signal of forwarded) process.on(signal, forward);
let failed = false;
child.on("error", (err) => {
  failed = true;
  const missing = err.code === "ENOENT";
  process.stderr.write("valet-secrets: " + command + (missing ? ": command not found" : ": could not start it (" + err.code + ")") + "\n");
  process.exitCode = missing ? 127 : 126;
});
child.on("close", (code, signal) => {
  for (const s of forwarded) process.off(s, forward);
  // A command that never started also closes. Keep the exit code set above.
  if (failed) return;
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  if (code !== null) process.exitCode = code;
});
`;
