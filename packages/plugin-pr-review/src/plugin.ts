import type { ValetPlugin } from "@valet/engine";
import { CHILD_ANSWER_NOTE, createReviewHandler, focusRole, REVIEWER_ROLE, VERIFIER_ROLE } from "./handler.js";
import { FOCUS_PROMPTS, REVIEW_FOCUSES, REVIEWER_SYSTEM_PROMPT } from "./prompt.js";
import { VERIFIER_SYSTEM_PROMPT } from "./verify.js";
import { LEARNED_DIR, LEARNER_ROLE, LEARNER_SYSTEM_PROMPT } from "./learn.js";

const plugin: ValetPlugin = {
  name: "pr-review",
  version: "0.1.0",
  displayName: "PR review",
  description: "Reviews each push to a pull request and keeps one review per pull request, edited in place.",
  // The handler borrows the GitHub App installation token to read the pull
  // request and post the review. The same declaration as the GitHub plugin's.
  credentials: [{ service: "github", type: "oauth2", scopes: [], configKeys: ["accessToken"], connectLabel: "Connect GitHub (via GitHub App)" }],
  // Lessons learned from review feedback: repository notes and general principles.
  memoryWrites: ["principles/", LEARNED_DIR],
  roles: [
    {
      name: REVIEWER_ROLE,
      description: "Reviews a pull request checked out at its head commit and answers with findings JSON.",
      content: `${REVIEWER_SYSTEM_PROMPT}\n\n${CHILD_ANSWER_NOTE("submit_review")}`,
      source: "plugin",
    },
    ...REVIEW_FOCUSES.map((focus) => ({
      name: focusRole(focus),
      description: `Reviews a pull request for one defect class (${focus}) and answers with findings JSON.`,
      content: `${REVIEWER_SYSTEM_PROMPT}\n\n${FOCUS_PROMPTS[focus]}\n\n${CHILD_ANSWER_NOTE("submit_review")}`,
      source: "plugin" as const,
    })),
    {
      name: VERIFIER_ROLE,
      description: "Checks one review finding against the code and answers with a verdict JSON.",
      content: `${VERIFIER_SYSTEM_PROMPT}\n\n${CHILD_ANSWER_NOTE("submit_verdict")}`,
      source: "plugin",
    },
    {
      name: LEARNER_ROLE,
      description: "Turns team feedback on a closed pull request into review lessons and answers with lessons JSON.",
      content: `${LEARNER_SYSTEM_PROMPT}\n\n${CHILD_ANSWER_NOTE("submit_lessons")}`,
      source: "plugin",
    },
  ],
  eventHandlers: [createReviewHandler()],
};

export default plugin;
