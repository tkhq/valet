/**
 * Prompt-template unit tests: the variable set, the write-time validator,
 * and the delivery-time renderer. Pure functions, no database.
 */
import { describe, expect, it, vi } from "vitest";
import type { EventCatalogEntry } from "@valet/engine";
import {
  buildPromptValues,
  MAX_PROMPT_TEMPLATE_CHARS,
  MAX_RENDERED_PROMPT_CHARS,
  renderEventPrompt,
  validatePromptTemplate,
} from "./prompt-template.js";

const CATALOG: EventCatalogEntry[] = [
  {
    key: "github.issues.opened",
    description: "GitHub issues opened",
    filters: [
      { field: "repo", path: "repository.full_name", description: "Repository" },
      { field: "sender", path: "sender.login", description: "Actor login" },
    ],
  },
];

const EVENT = {
  eventKey: "github.issues.opened",
  summary: "Issue #7 opened: broken build",
  body: "Issue #7 opened: broken build\n\n{json excerpt}",
  refs: { repo: "acme/site", installation_id: "42" },
  payload: { repository: { full_name: "acme/site" }, sender: { login: "octocat" } },
  catalog: CATALOG,
};

describe("buildPromptValues", () => {
  it("exposes the event key, the summary, the default body, refs and declared payload fields", () => {
    expect(buildPromptValues(EVENT)).toEqual({
      "event.key": "github.issues.opened",
      "event.summary": "Issue #7 opened: broken build",
      "event.body": "Issue #7 opened: broken build\n\n{json excerpt}",
      "refs.repo": "acme/site",
      "refs.installation_id": "42",
      "payload.repo": "acme/site",
      "payload.sender": "octocat",
    });
  });

  it("exposes no payload field that the event's catalog entry does not declare", () => {
    const values = buildPromptValues({
      ...EVENT,
      payload: { repository: { full_name: "acme/site" }, secret_token: "shh" },
    });
    expect(values["payload.secret_token"]).toBeUndefined();
    expect(Object.keys(values).filter((k) => k.startsWith("payload."))).toEqual(["payload.repo"]);
  });
});

describe("validatePromptTemplate", () => {
  it("accepts a template over the documented variable set", () => {
    const ok = "{{event.summary}} in {{refs.repo}} by {{payload.sender}}. Key: {{ event.key }}";
    expect(validatePromptTemplate(ok, "userPromptTemplate", CATALOG)).toBeNull();
  });

  it("accepts a template with no variables at all", () => {
    expect(validatePromptTemplate("Answer in one sentence.", "systemPrompt", CATALOG)).toBeNull();
  });

  it("refuses a non-string or an empty template", () => {
    expect(validatePromptTemplate(7, "systemPrompt", CATALOG)).toContain("must be a non-empty string");
    expect(validatePromptTemplate("   ", "systemPrompt", CATALOG)).toContain("must be a non-empty string");
  });

  it("refuses a template over the length cap", () => {
    const long = "x".repeat(MAX_PROMPT_TEMPLATE_CHARS + 1);
    expect(validatePromptTemplate(long, "systemPrompt", CATALOG)).toContain("too long");
  });

  it("refuses an unclosed placeholder", () => {
    expect(validatePromptTemplate("Look at {{event.summary", "systemPrompt", CATALOG)).toContain(
      "unclosed",
    );
  });

  it("refuses one placeholder nested in another, and says which brace to remove", () => {
    expect(validatePromptTemplate("Look at {{ {{event.key}} }}", "systemPrompt", CATALOG)).toContain(
      "nests",
    );
  });

  it("accepts a brace pair that closes no placeholder, so a JSON shape is writable", () => {
    for (const ok of [
      'Reply with JSON like {"summary": {"text": "x"}}',
      "Use the shape {{event.summary}} and end with }}",
      "A literal }} on its own.",
    ]) {
      expect(validatePromptTemplate(ok, "userPromptTemplate", CATALOG)).toBeNull();
    }
  });

  it("refuses event text in the instruction field, and names the field that takes it", () => {
    for (const name of ["event.summary", "event.body", "payload.sender"]) {
      const error = validatePromptTemplate(`Follow this: {{${name}}}`, "systemPrompt", CATALOG);
      expect(error).toContain(`{{${name}}}`);
      expect(error).toContain("userPromptTemplate");
    }
  });

  it("accepts the two names an instruction may use", () => {
    expect(
      validatePromptTemplate("Triage {{refs.repo}} on {{event.key}}.", "systemPrompt", CATALOG),
    ).toBeNull();
  });

  it("refuses a variable outside the documented set", () => {
    for (const bad of [
      "{{session.messages}}",
      "{{event.payload}}",
      "{{constructor}}",
      "{{__proto__}}",
      "{{refs.repo.length}}",
      "{{payload.repository.full_name}}",
      "{{}}",
    ]) {
      expect(validatePromptTemplate(bad, "userPromptTemplate", CATALOG)).not.toBeNull();
    }
  });

  it("refuses a payload field no selected event declares, and names the corrective action", () => {
    const error = validatePromptTemplate("{{payload.pr_number}}", "userPromptTemplate", CATALOG);
    expect(error).toContain("payload.pr_number");
    expect(error).toContain("repo");
  });
});

describe("renderEventPrompt", () => {
  const values = buildPromptValues(EVENT);

  it("delivers the default body unchanged when neither field is configured", () => {
    expect(renderEventPrompt({}, values)).toBe(EVENT.body);
  });

  it("renders the user template in place of the default body", () => {
    const body = renderEventPrompt(
      { userPromptTemplate: "{{payload.sender}} opened {{refs.repo}}: {{event.summary}}" },
      values,
    );
    expect(body).toBe("octocat opened acme/site: Issue #7 opened: broken build");
  });

  it("renders an unresolved variable as an empty string", () => {
    const sparse = buildPromptValues({ ...EVENT, refs: {}, payload: {} });
    expect(renderEventPrompt({ userPromptTemplate: "[{{refs.repo}}][{{payload.sender}}]" }, sparse)).toBe(
      "[][]",
    );
  });

  it("prepends the instructions block and keeps the default body under it", () => {
    const body = renderEventPrompt({ systemPrompt: "Answer in one sentence." }, values);
    expect(body).toBe(`Instructions for this subscription:\nAnswer in one sentence.\n\n---\n\n${EVENT.body}`);
  });

  it("combines the instructions block with a user template", () => {
    const body = renderEventPrompt(
      { systemPrompt: "Watch {{refs.repo}}.", userPromptTemplate: "{{event.summary}}" },
      values,
    );
    expect(body).toBe(
      "Instructions for this subscription:\nWatch acme/site.\n\n---\n\nIssue #7 opened: broken build",
    );
  });

  it("never re-renders a value that itself looks like a placeholder", () => {
    const hostile = buildPromptValues({
      ...EVENT,
      payload: { repository: { full_name: "{{payload.sender}}" }, sender: { login: "octocat" } },
    });
    expect(renderEventPrompt({ userPromptTemplate: "{{payload.repo}}" }, hostile)).toBe("{{payload.sender}}");
  });

  it("renders no event text inside the instruction block", () => {
    // The write gate refuses these names in `systemPrompt`. The renderer
    // holds the same line, so a row stored another way cannot put the
    // sender's words under the instructions heading.
    const body = renderEventPrompt(
      { systemPrompt: "Follow this: {{payload.sender}} {{event.summary}} {{event.body}}" },
      values,
    );
    expect(body).toBe(`Instructions for this subscription:\nFollow this:   \n\n---\n\n${EVENT.body}`);
  });

  it("delivers the default body when the user template renders to nothing", () => {
    const sparse = buildPromptValues({ ...EVENT, refs: {}, payload: {} });
    const onEmptyRender = vi.fn();
    const body = renderEventPrompt(
      { userPromptTemplate: "{{payload.sender}}" },
      sparse,
      onEmptyRender,
    );
    expect(body).toBe(EVENT.body);
    expect(onEmptyRender).toHaveBeenCalledTimes(1);
  });

  it("caps the rendered body", () => {
    const huge = buildPromptValues({ ...EVENT, summary: "y".repeat(MAX_RENDERED_PROMPT_CHARS * 2) });
    const body = renderEventPrompt({ userPromptTemplate: "{{event.summary}}" }, huge);
    expect(body.length).toBe(MAX_RENDERED_PROMPT_CHARS);
  });
});
