export const USER_FACING_TYPES: readonly ["feat", "fix", "improvement", "perf", "security"];
export const INTERNAL_TYPES: readonly ["build", "chore", "ci", "docs", "refactor", "test", "deps"];

export interface CommitMessage {
  commitSha: string;
  subject: string;
  body: string;
}

export type ParsedCommitMessage =
  | { ok: false; correction: string }
  | {
      ok: true;
      type: string;
      scope: string | null;
      breaking: boolean;
      summary: string;
      explicit: boolean;
      changelog: string | null;
      userFacing: boolean;
      metadataValid: boolean;
    };

export function parseCommitMessage(message: Pick<CommitMessage, "subject" | "body">): ParsedCommitMessage;
export function validateCommitMessage(message: CommitMessage): string[];
export function commitsIntroducedByPullRequest(options: {
  repo: string;
  baseSha: string;
  headSha: string;
}): CommitMessage[];
