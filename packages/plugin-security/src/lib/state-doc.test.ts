import { describe, expect, it } from "vitest";
import {
  collectStateDocViolations,
  parseStateDoc,
  ruleExit,
  stateDocIdentityViolations,
  stateDocWriteError,
  STATE_DOC_KEYS,
  type StateDoc,
} from "./state-doc.js";

/** A fully valid, strict-compliant state doc — every required key present,
 * counts integer, findings/log real lists. */
const FULL_DOC = `protocol_version: 1
engagement: eng_abc123
cell: 04-authz-sweep
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

/** The required keys a doc must carry — every one, minus the optional
 * engagement/mode. Handy for the "each missing key is named" tests. */
const MINIMAL_LINES = [
  "protocol_version: 1",
  "cell: 04-authz-sweep",
  "persona: code-review",
  "status: working",
  "checklist:",
  "  pending: 0",
  "  done: 0",
  "queue:",
  "  pending: 0",
  "  done: 0",
  "findings: []",
  "log: []",
];

function minimalDoc(): string {
  return MINIMAL_LINES.join("\n") + "\n";
}

describe("parseStateDoc — positive", () => {
  it("round-trips a fully valid document", () => {
    const doc = parseStateDoc(FULL_DOC);
    expect(doc).toEqual({
      protocolVersion: 1,
      engagement: "eng_abc123",
      cell: "04-authz-sweep",
      persona: "code-review",
      mode: "fresh",
      status: "working",
      checklist: { pending: 3, done: 14 },
      queue: { pending: 1, done: 22 },
      findings: ["fnd_9a1", "fnd_9a2"],
      log: ["swept routes for authz gaps"],
    });
  });

  it("accepts the minimal doc with empty findings/log and optional keys absent", () => {
    const doc = parseStateDoc(minimalDoc());
    expect(doc.engagement).toBeUndefined();
    expect(doc.mode).toBeUndefined();
    expect(doc.findings).toEqual([]);
    expect(doc.log).toEqual([]);
    expect(doc.checklist).toEqual({ pending: 0, done: 0 });
    expect(doc.queue).toEqual({ pending: 0, done: 0 });
  });

  it("accepts a valid mode of resume", () => {
    const doc = parseStateDoc(minimalDoc().replace("status: working", "mode: resume\nstatus: working"));
    expect(doc.mode).toBe("resume");
  });

  it("accepts status done when both pending counts are zero", () => {
    const doc = parseStateDoc(minimalDoc().replace("status: working", "status: done"));
    expect(doc.status).toBe("done");
  });
});

describe("parseStateDoc — YAML and shape", () => {
  it("rejects unparseable YAML with a corrective message", () => {
    expect(() => parseStateDoc("status: [unclosed")).toThrow(/not valid YAML/);
    expect(() => parseStateDoc("status: [unclosed")).toThrow(/protocol\.md/);
  });

  it("rejects a non-map document", () => {
    expect(() => parseStateDoc("- a\n- b\n")).toThrow(/YAML map/);
  });
});

describe("parseStateDoc — unknown keys", () => {
  it("rejects an unknown key by name and lists the allowed keys", () => {
    const bad = minimalDoc() + "notes: whatever\n";
    expect(() => parseStateDoc(bad)).toThrow(/unknown key "notes"/);
    expect(() => parseStateDoc(bad)).toThrow(new RegExp(STATE_DOC_KEYS.join(", ")));
  });

  it("names a typo'd key (checklsit) rather than silently ignoring it", () => {
    const bad = minimalDoc() + "checklsit:\n  pending: 0\n  done: 0\n";
    expect(() => parseStateDoc(bad)).toThrow(/unknown key "checklsit"/);
  });
});

/** Rebuild the minimal doc without one required key. For a block key
 * (checklist/queue) it also drops the two indented count lines under it. */
function docWithout(key: string): string {
  const out: string[] = [];
  let skippingIndented = false;
  for (const line of MINIMAL_LINES) {
    if (line.startsWith(`${key}:`)) {
      skippingIndented = key === "checklist" || key === "queue";
      continue;
    }
    if (skippingIndented && line.startsWith("  ")) continue;
    skippingIndented = false;
    out.push(line);
  }
  return out.join("\n") + "\n";
}

describe("parseStateDoc — required keys", () => {
  const required = ["protocol_version", "cell", "persona", "status", "checklist", "queue", "findings", "log"];
  for (const key of required) {
    it(`names the missing required key "${key}"`, () => {
      expect(() => parseStateDoc(docWithout(key))).toThrow(new RegExp(`missing required key "${key}"`));
    });
  }
});

describe("parseStateDoc — field values", () => {
  it("rejects a wrong protocol_version and names the value", () => {
    expect(() => parseStateDoc(minimalDoc().replace("protocol_version: 1", "protocol_version: 2"))).toThrow(
      /protocol_version must be 1/,
    );
  });

  it("rejects an invalid status naming the allowed set", () => {
    expect(() => parseStateDoc(minimalDoc().replace("status: working", "status: finished"))).toThrow(
      /status must be one of working, yielding, done/,
    );
  });

  it("rejects an invalid mode", () => {
    expect(() => parseStateDoc(minimalDoc().replace("status: working", "mode: partial\nstatus: working"))).toThrow(
      /mode must be one of fresh, resume/,
    );
  });

  it("rejects a blank cell", () => {
    expect(() => parseStateDoc(minimalDoc().replace("cell: 04-authz-sweep", 'cell: ""'))).toThrow(
      /"cell" must be a non-empty string/,
    );
  });

  it("rejects a non-string persona", () => {
    expect(() => parseStateDoc(minimalDoc().replace("persona: code-review", "persona: 7"))).toThrow(
      /"persona" must be a non-empty string/,
    );
  });
});

describe("parseStateDoc — counts", () => {
  it("rejects a non-number count", () => {
    expect(() => parseStateDoc(minimalDoc().replace("  pending: 0\n  done: 0\nqueue:", "  pending: lots\n  done: 0\nqueue:"))).toThrow(
      /checklist\.pending must be an integer >= 0 \(got "lots"\)/,
    );
  });

  it("rejects a float count", () => {
    expect(() => parseStateDoc(minimalDoc().replace("  pending: 0\n  done: 0\nqueue:", "  pending: 1.5\n  done: 0\nqueue:"))).toThrow(
      /checklist\.pending must be an integer >= 0 \(got 1.5\)/,
    );
  });

  it("rejects a negative count", () => {
    expect(() => parseStateDoc(minimalDoc().replace("  pending: 0\n  done: 0\nqueue:", "  pending: -1\n  done: 0\nqueue:"))).toThrow(
      /checklist\.pending must be an integer >= 0 \(got -1\)/,
    );
  });

  it("rejects a missing count inside a present block", () => {
    // checklist with only done — pending is absent.
    const content = minimalDoc().replace("checklist:\n  pending: 0\n  done: 0", "checklist:\n  done: 4");
    expect(() => parseStateDoc(content)).toThrow(/checklist\.pending must be an integer >= 0 \(got undefined\)/);
  });

  it("rejects a checklist that is not a map", () => {
    const content = minimalDoc().replace("checklist:\n  pending: 0\n  done: 0", "checklist: none");
    expect(() => parseStateDoc(content)).toThrow(/checklist must be a map with pending and done counts/);
  });
});

describe("parseStateDoc — findings and log lists", () => {
  it("rejects non-text findings entries", () => {
    expect(() => parseStateDoc(minimalDoc().replace("findings: []", "findings: [1, 2]"))).toThrow(
      /findings must be a list of text entries/,
    );
  });

  it("rejects a scalar log", () => {
    expect(() => parseStateDoc(minimalDoc().replace("log: []", "log: notalist"))).toThrow(
      /log must be a list of text entries/,
    );
  });
});

describe("parseStateDoc — done consistency", () => {
  it("rejects status done while checklist.pending is not zero", () => {
    const content = minimalDoc()
      .replace("status: working", "status: done")
      .replace("checklist:\n  pending: 0\n  done: 0", "checklist:\n  pending: 2\n  done: 3");
    expect(() => parseStateDoc(content)).toThrow(/status is done but checklist\.pending is 2, not 0/);
  });

  it("rejects status done while queue.pending is not zero", () => {
    const content = minimalDoc()
      .replace("status: working", "status: done")
      .replace("queue:\n  pending: 0\n  done: 0", "queue:\n  pending: 5\n  done: 1");
    expect(() => parseStateDoc(content)).toThrow(/status is done but queue\.pending is 5, not 0/);
  });
});

describe("collectStateDocViolations — reports every problem at once", () => {
  it("names a count of N and every distinct violation in one message", () => {
    const bad = "protocol_version: 2\nstatus: bogus\ncell: c\npersona: p\nfindings: []\nlog: []\n";
    const { violations } = collectStateDocViolations(bad);
    // At least: missing checklist, missing queue, wrong protocol_version, bad status.
    expect(violations.length).toBeGreaterThan(1);
    const message = stateDocWriteError(violations);
    expect(message).toContain(`${violations.length} problem(s)`);
    expect(message).toContain("protocol_version must be 1");
    expect(message).toContain("status must be one of working, yielding, done");
  });

  it("returns a null doc when the status is not a valid enum", () => {
    const { doc } = collectStateDocViolations("protocol_version: 1\nstatus: nope\n");
    expect(doc).toBeNull();
  });

  it("still builds a doc for the identity check when status is valid but other fields violate", () => {
    // Valid status, but findings has a non-string — the caller still needs the
    // doc (with its cell/persona) for the identity check.
    const content = minimalDoc().replace("findings: []", "findings: [1]");
    const { doc, violations } = collectStateDocViolations(content);
    expect(doc).not.toBeNull();
    expect(doc?.cell).toBe("04-authz-sweep");
    expect(violations.some((v) => v.includes("findings must be a list of text entries"))).toBe(true);
  });
});

describe("stateDocIdentityViolations", () => {
  const doc: StateDoc = {
    protocolVersion: 1,
    cell: "04-authz-sweep",
    persona: "code-review",
    status: "working",
    checklist: { pending: 0, done: 0 },
    queue: { pending: 0, done: 0 },
    findings: [],
    log: [],
  };

  it("returns no violations when cell and persona match", () => {
    expect(stateDocIdentityViolations(doc, { cell: "04-authz-sweep", persona: "code-review" })).toEqual([]);
  });

  it("names the cell mismatch and tells the persona to set the right value", () => {
    const v = stateDocIdentityViolations(doc, { cell: "05-injection", persona: "code-review" });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("cell");
    expect(v[0]).toContain('Set "cell: 05-injection"');
    expect(v[0]).toMatch(/never copy the protocol example/);
  });

  it("names the persona mismatch and tells the persona to set the right value", () => {
    const v = stateDocIdentityViolations(doc, { cell: "04-authz-sweep", persona: "dast" });
    expect(v).toHaveLength(1);
    expect(v[0]).toContain("persona");
    expect(v[0]).toContain('Set "persona: dast"');
  });

  it("names both mismatches when both are wrong", () => {
    const v = stateDocIdentityViolations(doc, { cell: "05-injection", persona: "dast" });
    expect(v).toHaveLength(2);
    expect(v.join("\n")).toContain('Set "cell: 05-injection"');
    expect(v.join("\n")).toContain('Set "persona: dast"');
  });
});

describe("stateDocWriteError", () => {
  it("formats a single combined corrective naming every violation", () => {
    const message = stateDocWriteError(["problem A", "problem B"]);
    expect(message).toContain("state.yml has 2 problem(s):");
    expect(message).toContain("  - problem A");
    expect(message).toContain("  - problem B");
    expect(message).toContain("Write state.yml again following /protocol.md.");
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
