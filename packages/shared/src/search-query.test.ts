import { describe, expect, it } from "vitest";
import {
  MAX_SEARCH_QUERY_LENGTH,
  MAX_SEARCH_QUERY_TERMS,
  matchesAllSearchTerms,
  matchesSearchQuery,
  parseSearchQuery,
  rankSearchResults,
  searchMatchScore,
  tokenizeSearchQuery,
} from "./search-query.js";

const term = (text: string, quoted = false, negative = false) => ({ text, quoted, negative });

describe("local search query", () => {
  it("preserves phrases and structured identifiers", () => {
    expect(tokenizeSearchQuery('linear.list_projects "project updates" milestones')).toEqual([
      term("linear.list_projects"),
      term("project updates", true),
      term("milestones"),
    ]);
  });

  it("handles apostrophes and mid-token quotes without broad quote terms", () => {
    expect(tokenizeSearchQuery("Conner's rock 'n' roll 'tis foo\"bar rock'n'roll")).toEqual([
      term("Conner's"),
      term("rock"),
      term("roll"),
      term("tis"),
      term("foo"),
      term("bar"),
      term("rock'n'roll"),
    ]);
    expect(tokenizeSearchQuery("'Conner's notes'")).toEqual([term("Conner's notes", true)]);
  });

  it("treats an unmatched opening quote as punctuation", () => {
    expect(tokenizeSearchQuery('"projects milestones')).toEqual([
      term("projects"),
      term("milestones"),
    ]);
    expect(tokenizeSearchQuery("-'archived current")).toEqual([
      term("current"),
      term("archived", false, true),
    ]);
  });

  it("normalizes uppercase OR and parses exclusions", () => {
    const parsed = parseSearchQuery('projects OR "release updates" -archived -32000');
    expect(parsed.positive).toEqual([term("projects"), term("release updates", true)]);
    expect(parsed.negative).toEqual([term("archived", false, true), term("32000", false, true)]);
    expect(matchesSearchQuery("OR", ["ordinary"])).toBe(false);
    expect(matchesSearchQuery("-", ["foo-bar"])).toBe(false);
    expect(matchesSearchQuery("-archived", ["current"])).toBe(false);
  });

  it("bounds input and keeps the first unique terms deterministically", () => {
    const terms = Array.from({ length: 20 }, (_, index) => `term${index}`);
    const parsed = parseSearchQuery(`${terms.join(" ")} ${"x".repeat(MAX_SEARCH_QUERY_LENGTH)}`);
    expect(parsed.positive.map(({ text }) => text)).toEqual(terms.slice(0, MAX_SEARCH_QUERY_TERMS));
    expect(parsed.truncated).toBe(true);
  });

  it("deduplicates case-insensitively before matching and scoring", () => {
    const parsed = parseSearchQuery("PROJECTS projects Projects milestones -ARCHIVED -archived");
    expect(parsed.positive).toEqual([term("PROJECTS"), term("milestones")]);
    expect(parsed.negative).toEqual([term("ARCHIVED", false, true)]);
    expect(searchMatchScore(parsed, ["projects"])).toBe(1);
  });

  it("lets an exclusion win over the same positive term", () => {
    for (const query of ["projects -PROJECTS", "-PROJECTS projects"]) {
      const parsed = parseSearchQuery(query);
      expect(parsed.positive).toEqual([]);
      expect(parsed.negative).toHaveLength(1);
      expect(parsed.negative[0]?.text.toLowerCase()).toBe("projects");
      expect(matchesSearchQuery(parsed, ["projects"])).toBe(false);
    }
  });

  it("OR-matches positive terms, applies exclusions, and keeps phrases exact", () => {
    expect(matchesSearchQuery('projects "release updates"', ["Quarterly release updates"])).toBe(true);
    expect(matchesSearchQuery('projects "release updates"', ["Release notes and updates"])).toBe(false);
    expect(matchesSearchQuery("projects milestones -archived", ["projects archived"])).toBe(false);
    expect(matchesSearchQuery("", [])).toBe(true);
  });

  it("supports narrowing matches for client filters", () => {
    expect(matchesAllSearchTerms("fix login", ["fix login flow"])).toBe(true);
    expect(matchesAllSearchTerms("fix login", ["fix export flow"])).toBe(false);
  });

  it("ranks distinct matches and keeps ties stable", () => {
    const items = ["milestones", "projects and milestones", "projects", "other"];
    expect(rankSearchResults("projects PROJECTS milestones", items, (item) => [item])).toEqual([
      "projects and milestones",
      "milestones",
      "projects",
    ]);
  });
});
