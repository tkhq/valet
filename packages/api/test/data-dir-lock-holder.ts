/**
 * A process that plays a second API boot: it takes the one-owner lock on a
 * data directory and then holds it until it is killed.
 *
 * `src/providers/data-dir-lock.test.ts` drives it. A real process is the only
 * way to prove the two cases that matter — a LIVE second owner, and the state
 * a SIGKILL leaves behind — because both depend on the operating system, not
 * on anything this code can simulate.
 *
 * Protocol:
 *   1. prints `ready` and waits for a line on stdin. The wait is a starting
 *      gate: it lets the test release several of these at the same moment,
 *      so they contend for the lock instead of taking it in turn.
 *   2. prints `holding <pid>` and stays alive, or prints `refused` plus the
 *      refusal message to stderr and exits 4.
 *
 * argv: [pgDataDir]
 */
import { acquireDataDirLock, DataDirLockError } from "../src/providers/data-dir-lock.js";

const [pgDataDir] = process.argv.slice(2);
if (!pgDataDir) {
  process.stderr.write("usage: data-dir-lock-holder.ts <pgDataDir>\n");
  process.exit(2);
}

process.stdout.write("ready\n");

await new Promise<void>((resolve) => {
  process.stdin.once("data", () => resolve());
  process.stdin.resume();
});

try {
  acquireDataDirLock({ pgDataDir });
} catch (err) {
  if (err instanceof DataDirLockError) {
    process.stderr.write(`refused ${err.code}\n${err.message}\n`);
    process.exit(4);
  }
  throw err;
}

process.stdout.write(`holding ${process.pid}\n`);
// Nothing else to do, and the lock is a file rather than an open handle, so
// this process needs its own reason to stay alive.
setInterval(() => {}, 1_000);
