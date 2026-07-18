/**
 * Stable process exit codes for the `valet` CLI, plus the typed error classes
 * that carry them. The dispatcher catches thrown errors and uses
 * `err instanceof CliError ? err.exitCode : 1`, so any error that wants a
 * specific exit code must extend `CliError`.
 */

/**
 * Distinct, stable exit codes. Non-zero values are chosen to be
 * unambiguous across subcommands so scripts can branch on them:
 *
 * - OK (0)          — success.
 * - Usage (2)       — bad invocation: unknown command, missing/typo'd
 *                     profile, no instance selected. (Also the "no args"
 *                     and unknown-subcommand code.)
 * - GatePending (3) — a turn is blocked on a pending decision gate.
 * - TurnError (4)   — an agent turn errored while running.
 * - AuthFailure (5) — authentication against an instance failed.
 * - Unreachable (6) — the target instance could not be reached.
 */
export enum ExitCode {
  OK = 0,
  Usage = 2,
  GatePending = 3,
  TurnError = 4,
  AuthFailure = 5,
  Unreachable = 6,
}

/** Base class for every CLI error that maps to a specific exit code. */
export class CliError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

/** Malformed / unreadable config file. Generic failure (exit 1). */
export class ConfigError extends CliError {
  constructor(message: string) {
    super(message, 1);
  }
}

/** A profile was named but is absent from `config.profiles`. */
export class ProfileNotFoundError extends CliError {
  constructor(name: string) {
    super(`profile "${name}" not found. Run \`valet login\` to add it, or check your config.`, ExitCode.Usage);
  }
}

/** No instance selected and no `defaultProfile` configured. */
export class NoInstanceError extends CliError {
  constructor() {
    super("no instance selected. Run `valet login` to add one, or pass --instance.", ExitCode.Usage);
  }
}

/** Authentication against an instance failed. */
export class AuthError extends CliError {
  constructor(message: string) {
    super(message, ExitCode.AuthFailure);
  }
}

/** The target instance could not be reached. */
export class UnreachableError extends CliError {
  constructor(message: string) {
    super(message, ExitCode.Unreachable);
  }
}

/** Generic API failure carrying the HTTP status and response body. */
export class ApiError extends CliError {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string, message?: string) {
    super(message ?? `API request failed with status ${status}`, 1);
    this.status = status;
    this.body = body;
  }
}
