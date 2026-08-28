import { describe, expect, it } from "vitest";
import { parseStateDoc, ruleExit, type StateDoc } from "./state-doc.js";

const FULL_DOC = `protocol_version: 1
engagement: eng_abc123
cell: cell_01
persona: code-review
mode: fresh
status: working
checklist:
  pending: 3
  done: 14
queue:
  pending: 1
  done: 22
findings: [fnd_9a1, fnd_9a2]
log:
  - "swept routes for authz gaps"
`;

describe("parseStateDoc", () => {
  it("parses a full document", () => {
    const doc = parseStateDoc(FULL_DOC);
    expect(doc).toEqual({
      protocolVersion: 1,
      engagement: "eng_abc123",
      cell: "cell_01",
      persona: "code-review",
      mode: "fresh",
      status: "working",
      checklist: { pending: 3, done: 14 },
      queue: { pending: 1, done: 22 },
      findings: ["fnd_9a1", "fnd_9a2"],
      log: ["swept routes for authz gaps"],
    });
  });

  it("defaults missing checklist/queue blocks and findings/log", () => {
    const doc = parseStateDoc("protocol_version: 1\nstatus: done\n");
    expect(doc.checklist).toEqual({ pending: 0, done: 0 });
    expect(doc.queue).toEqual({ pending: 0, done: 0 });
    expect(doc.findings).toEqual([]);
    expect(doc.log).toEqual([]);
  });

  it("defaults a missing count inside a present block to 0", () => {
    const doc = parseStateDoc("protocol_version: 1\nstatus: done\nchecklist:\n  done: 4\n");
    expect(doc.checklist).toEqual({ pending: 0, done: 4 });
  });

  it("rejects unparseable YAML with a corrective message", () => {
    expect(() => parseStateDoc("status: [unclosed")).toThrow(/not valid YAML/);
    expect(() => parseStateDoc("status: [unclosed")).toThrow(/protocol\.md/);
  });

  it("rejects a non-map document", () => {
    expect(() => parseStateDoc("- a\n- b\n")).toThrow(/YAML map/);
  });

  it("rejects an unknown protocol_version", () => {
    expect(() => parseStateDoc("protocol_version: 2\nstatus: done\n")).toThrow(
      /protocol_version 2; the only known version is 1/,
    );
    expect(() => parseStateDoc("status: done\n")).toThrow(
      /protocol_version undefined; the only known version is 1/,
    );
  });

  it("rejects a missing or invalid status", () => {
    expect(() => parseStateDoc("protocol_version: 1\n")).toThrow(
      /status "undefined"; use working, yielding, or done/,
    );
    expect(() => parseStateDoc("protocol_version: 1\nstatus: finished\n")).toThrow(
      /status "finished"/,
    );
  });

  it("rejects non-number pending/done counts", () => {
    expect(() =>
      parseStateDoc("protocol_version: 1\nstatus: done\nchecklist:\n  pending: lots\n"),
    ).toThrow(/checklist\.pending is "lots", not a number/);
    expect(() =>
      parseStateDoc("protocol_version: 1\nstatus: done\nqueue:\n  done: [1]\n"),
    ).toThrow(/queue\.done is \[1\], not a number/);
  });

  it("rejects non-text findings and log entries", () => {
    expect(() =>
      parseStateDoc("protocol_version: 1\nstatus: done\nfindings: [1, 2]\n"),
    ).toThrow(/findings must be a list of text entries/);
    expect(() =>
      parseStateDoc("protocol_version: 1\nstatus: done\nlog: notalist\n"),
    ).toThrow(/log must be a list of text entries/);
  });
});

function docWith(overrides: Partial<StateDoc>): StateDoc {
  return {
    protocolVersion: 1,
    status: "working",
    checklist: { pending: 0, done: 0 },
    queue: { pending: 0, done: 0 },
    findings: [],
    log: [],
    ...overrides,
  };
}

describe("ruleExit", () => {
  it("rules yielding as yielded regardless of counts", () => {
    expect(
      ruleExit(docWith({ status: "yielding", checklist: { pending: 9, done: 1 } })),
    ).toEqual({ outcome: "yielded" });
  });

  it("rules done with both pending counts zero as done", () => {
    expect(
      ruleExit(
        docWith({
          status: "done",
          checklist: { pending: 0, done: 14 },
          queue: { pending: 0, done: 22 },
        }),
      ),
    ).toEqual({ outcome: "done" });
  });

  it("rules working as a violation naming the fix", () => {
    const ruling = ruleExit(docWith({ status: "working" }));
    expect(ruling).toEqual({
      outcome: "violation",
      violation: "status is working — write a final state doc with status done or yielding",
    });
  });

  it("rules done with pending checklist items as a violation naming the count", () => {
    const ruling = ruleExit(
      docWith({ status: "done", checklist: { pending: 3, done: 10 } }),
    );
    expect(ruling).toEqual({
      outcome: "violation",
      violation: "status is done but checklist.pending is 3, not 0",
    });
  });

  it("rules done with pending queue items as a violation naming the count", () => {
    const ruling = ruleExit(docWith({ status: "done", queue: { pending: 2, done: 5 } }));
    expect(ruling).toEqual({
      outcome: "violation",
      violation: "status is done but queue.pending is 2, not 0",
    });
  });
});
