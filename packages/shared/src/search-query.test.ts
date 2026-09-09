import { describe, expect, it } from "vitest";
import {
  hasExplicitSearchOperator,
  matchesSearchQuery,
  rankSearchResults,
  tokenizeSearchQuery,
} from "./search-query.js";

describe("local search query", () => {
  it("splits unquoted terms and preserves phrases and structured identifiers", () => {
    expect(tokenizeSearchQuery('linear.list_projects "project updates" milestones')).toEqual([
      { text: "linear.list_projects", quoted: false },
      { text: "project updates", quoted: true },
      { text: "milestones", quoted: false },
    ]);
  });

  it("keeps apostrophes and single-quoted phrases intact", () => {
    expect(tokenizeSearchQuery("Conner's 'project updates' 'Conner's notes'")).toEqual([
      { text: "Conner's", quoted: false },
      { text: "project updates", quoted: true },
      { text: "Conner's notes", quoted: true },
    ]);
  });

  it("treats an unmatched opening quote as punctuation", () => {
    expect(tokenizeSearchQuery('"projects milestones')).toEqual([
      { text: "projects", quoted: false },
      { text: "milestones", quoted: false },
    ]);
  });

  it("matches any term but keeps a quoted phrase exact", () => {
    expect(matchesSearchQuery('projects "release updates"', ["Quarterly release updates"])).toBe(
      true,
    );
    expect(matchesSearchQuery('projects "release updates"', ["Release notes and updates"])).toBe(
      false,
    );
    expect(matchesSearchQuery("", [])).toBe(true);
  });

  it("ranks matches with more query terms first and keeps ties stable", () => {
    const items = ["milestones", "projects and milestones", "projects", "other"];
    expect(rankSearchResults("projects milestones", items, (item) => [item])).toEqual([
      "projects and milestones",
      "milestones",
      "projects",
    ]);
  });

  it("detects explicit web-search operators outside phrases", () => {
    expect(hasExplicitSearchOperator("projects OR milestones")).toBe(true);
    expect(hasExplicitSearchOperator("projects -archived")).toBe(true);
    expect(hasExplicitSearchOperator("projects AND milestones")).toBe(false);
    expect(hasExplicitSearchOperator('"projects OR milestones"')).toBe(false);
    expect(hasExplicitSearchOperator("Conner's projects")).toBe(false);
  });
});
