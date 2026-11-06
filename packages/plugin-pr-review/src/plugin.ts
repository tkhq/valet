import type { ValetPlugin } from "@valet/engine";
import { CHILD_ANSWER_NOTE, createReviewHandler, REVIEWER_ROLE, VERIFIER_ROLE } from "./handler.js";
import { REVIEWER_SYSTEM_PROMPT } from "./prompt.js";
import { VERIFIER_SYSTEM_PROMPT } from "./verify.js";

const plugin: ValetPlugin = {
  name: "pr-review",
  version: "0.1.0",
  displayName: "PR review",
  description: "Reviews each push to a pull request and keeps one review per pull request, edited in place.",
  // The handler borrows the GitHub App installation token to read the pull
  // request and post the review. The same declaration as the GitHub plugin's.
  credentials: [{ service: "github", type: "oauth2", scopes: [], configKeys: ["accessToken"], connectLabel: "Connect GitHub (via GitHub App)" }],
  roles: [
    {
      name: REVIEWER_ROLE,
      description: "Reviews a pull request checked out at its head commit and answers with findings JSON.",
      content: `${REVIEWER_SYSTEM_PROMPT}\n\n${CHILD_ANSWER_NOTE("submit_review")}`,
      source: "plugin",
    },
    {
      name: VERIFIER_ROLE,
      description: "Checks one review finding against the code and answers with a verdict JSON.",
      content: `${VERIFIER_SYSTEM_PROMPT}\n\n${CHILD_ANSWER_NOTE("submit_verdict")}`,
      source: "plugin",
    },
  ],
  eventHandlers: [createReviewHandler()],
};

export default plugin;
