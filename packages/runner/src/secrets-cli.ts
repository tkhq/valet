#!/usr/bin/env bun
/**
 * `valet secrets` — the credential surface an agent is given.
 *
 * The agent describes DELIVERY, never reads a value:
 *
 *   valet secrets run --env GITHUB_TOKEN=op://Eng/GitHub/token -- gh pr list
 *   valet secrets list
 *
 * `run` resolves each `op://` reference through the broker and puts the value
 * in the child process's environment. It never prints one, and it masks any
 * that appear in the child's output — a command that echoes its own
 * environment prints `***`, not the token.
 *
 * This exists instead of a "read a secret" tool on purpose. A tool that
 * returns a secret puts it in the transcript, in the model's context, and in
 * every log that carries either. Naming a destination does not.
 */
import { parseArgs } from "util";
import { listSecrets, runWithSecrets, isConfigured } from "./secrets.js";

function usage(): never {
  console.error(
    [
      "usage:",
      "  valet secrets run --env NAME=op://vault/item/field [--env …] -- <command> [args…]",
      "  valet secrets list [--vault <id>]",
      "",
      "run puts each secret in the command's environment. It is never printed.",
    ].join("\n"),
  );
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") usage();

  if (!(await isConfigured())) {
    console.error(
      "No secrets provider is reachable. Inside a session this needs VALET_API_URL and " +
        "VALET_SANDBOX_TOKEN, which the sandbox is started with.",
    );
    process.exit(1);
  }

  if (command === "list") {
    const { values } = parseArgs({
      args: argv.slice(1),
      options: { vault: { type: "string" } },
      allowPositionals: false,
    });
    const entries = await listSecrets(values.vault);
    if (entries.length === 0) {
      console.log("No secrets listed. The broker resolves references but does not enumerate them.");
      return;
    }
    for (const e of entries) console.log(`${e.reference}\t${e.item}\t${e.vault}`);
    return;
  }

  if (command === "run") {
    // Everything after `--` is the command; everything before it is ours.
    const sep = argv.indexOf("--");
    if (sep === -1 || sep === argv.length - 1) usage();
    const { values } = parseArgs({
      args: argv.slice(1, sep),
      options: { env: { type: "string", multiple: true } },
      allowPositionals: false,
    });

    const envMap: Record<string, string> = {};
    for (const pair of values.env ?? []) {
      const eq = pair.indexOf("=");
      if (eq <= 0) {
        console.error(`--env expects NAME=reference, got: ${pair}`);
        process.exit(2);
      }
      envMap[pair.slice(0, eq)] = pair.slice(eq + 1);
    }
    if (Object.keys(envMap).length === 0) usage();

    const result = await runWithSecrets(argv.slice(sep + 1).join(" "), envMap);
    // The child's own streams, already masked by `runWithSecrets`.
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.timedOut) console.error("the command timed out");
    process.exit(result.exitCode ?? (result.timedOut ? 124 : 0));
  }

  usage();
}

main().catch((err: unknown) => {
  // A resolution failure names the REFERENCE, never the value or the vault's
  // contents.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
