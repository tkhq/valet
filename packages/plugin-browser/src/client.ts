import { createHash } from "node:crypto";
import type { Sandbox } from "@valet/engine";
import { browserChannelRequest } from "./channel.js";
import type {
  BrowserExportDescriptor,
  BrowserRequest,
  BrowserResponse,
} from "@valet/shared";

/** Fixed executable and JSON stdin keep model source out of the shell parser. */
export async function browserRequest(
  sandbox: Sandbox,
  request: BrowserRequest,
  signal?: AbortSignal,
): Promise<BrowserResponse> {
  let parsed: unknown = await browserChannelRequest(sandbox, request, signal);
  if (parsed === null) {
    const result = await sandbox.exec("/usr/local/bin/valet-browser-client", {
      target: "browser",
      stdin: JSON.stringify(request),
      timeout: 35_000,
      maxOutputBytes: 1_048_576,
      signal,
      privileged: true,
    });
    if (result.exitCode !== 0 && !result.stdout.trim().startsWith("{")) {
      throw new Error(
        "The sandbox browser is unavailable. Start a sandbox with the Valet browser image and retry.",
      );
    }
    parsed = JSON.parse(result.stdout);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    !("protocolVersion" in parsed) ||
    parsed.protocolVersion !== "1.0" ||
    !("ok" in parsed) ||
    typeof parsed.ok !== "boolean" ||
    !("runtimeId" in parsed) ||
    typeof parsed.runtimeId !== "string" ||
    !("events" in parsed) ||
    !Array.isArray(parsed.events) ||
    !("cursor" in parsed) ||
    typeof parsed.cursor !== "number"
  ) {
    throw new Error(
      "The browser returned an incompatible response. Update the sandbox browser image.",
    );
  }
  // The daemon validates its typed response; the transport also checks its envelope.
  const response = parsed as BrowserResponse;
  if (!response.ok)
    throw new Error(
      `${response.error?.message ?? "The browser request failed."} ${response.error?.correctiveAction ?? "Inspect browser status before retrying."}`,
    );
  return response;
}

export async function readBrowserExport(
  sandbox: Sandbox,
  artifact: BrowserExportDescriptor,
): Promise<Uint8Array> {
  if (
    !/^\/var\/lib\/valet\/browser\/transfers\/[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(
      artifact.path,
    ) ||
    artifact.bytes < 0 ||
    artifact.bytes > 100 * 1024 * 1024
  ) {
    throw new Error(
      "The browser export path or size is invalid. Capture new browser evidence.",
    );
  }
  // Private files are never read through the workload's general file API.
  // The host supplies the daemon-issued transfer path over stdin, not shell text.
  const script = `const fs=require("node:fs/promises"),c=require("node:fs").constants; (async()=>{let input="";for await(const chunk of process.stdin)input+=chunk;const {path,bytes}=JSON.parse(input);const root=await fs.realpath("/var/lib/valet/browser/transfers");const real=await fs.realpath(path);if(!real.startsWith(root+"/")||(await fs.lstat(path)).isSymbolicLink())throw Error("Invalid transfer path");const file=await fs.open(path,c.O_RDONLY|c.O_NOFOLLOW);try{const stat=await file.stat();if(!stat.isFile()||stat.size!==bytes||stat.size>104857600)throw Error("Invalid transfer size");process.stdout.write((await file.readFile()).toString("base64"));}finally{await file.close();}})().catch(e=>{process.stderr.write(e.message);process.exit(1)});`;
  const result = await sandbox.exec(
    `/usr/bin/env -i PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node -e '${script}'`,
    {
      stdin: JSON.stringify({ path: artifact.path, bytes: artifact.bytes }),
      target: "browser",
      privileged: true,
      timeout: 35_000,
      maxOutputBytes: Math.ceil(artifact.bytes / 3) * 4 + 1024,
    },
  );
  if (result.exitCode !== 0)
    throw new Error(
      "Browser evidence could not be read. Capture new browser evidence.",
    );
  const bytes = new Uint8Array(Buffer.from(result.stdout, "base64"));
  if (
    bytes.byteLength !== artifact.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== artifact.sha256
  ) {
    throw new Error(
      "Browser evidence failed its integrity check. Capture new browser evidence.",
    );
  }
  return bytes;
}
