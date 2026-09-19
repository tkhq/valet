import { Buffer } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BENIGN_SOURCE } from "./__fixtures__/benign-source.js";
import {
  assertNoSecurityCredentialOutput,
  clearSecurityCredentialSession,
  MIN_CREDENTIAL_FRAGMENT,
  registerSecurityCredentialValue,
  sanitizeSecurityCredentialOutput,
  SECURITY_CREDENTIAL_OUTPUT_BLOCKED,
} from "./security-credential-tripwire.js";

// The alert sink is injected, not mocked at the module level. This suite
// shares a module registry with every other api suite, so a module mock
// only applies when this file happens to load the module first.
const alertSpy = vi.fn();

/** Register a value and send its fragment alerts to the spy. */
function register(sessionId: string, engagementId: string, value: string): void {
  registerSecurityCredentialValue(sessionId, engagementId, value, { onAlert: alertSpy });
}

const SESSION = "cell-session";
const ENGAGEMENT = "engagement";
const SECRET = "sentinel+/ credential";

/**
 * Four 8-character chunks of a 32-character value. Eight is the minimum
 * fragment the tripwire tracks, so every split fixture in this file emits
 * chunks at or above it. A shorter chunk is deliberately invisible: see
 * the accepted-residual test below.
 */
const VALUE_32 = "Zq7Rt2WmXb4Yc6VdUe0Tf1SgRh5PjKn8";
const CHUNKS = [
  VALUE_32.slice(0, 8),
  VALUE_32.slice(8, 16),
  VALUE_32.slice(16, 24),
  VALUE_32.slice(24, 32),
];

/** Deterministic PEM-looking value for the scan-cost tests. */
function pemValue(rows: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let state = 0x2f6f2b79;
  const lines: string[] = ["-----BEGIN RSA PRIVATE KEY-----"];
  for (let line = 0; line < rows; line += 1) {
    let row = "";
    for (let col = 0; col < 64; col += 1) {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      row += alphabet[(state >>> 8) % alphabet.length];
    }
    lines.push(row);
  }
  lines.push("-----END RSA PRIVATE KEY-----");
  return lines.join("\n");
}

/** A copy of `value` with one character altered every `spacing` positions. */
function alteredCopy(value: string, spacing: number): string {
  let copy = "";
  for (let at = 0; at < value.length; at += 1) {
    const alter = (at + 1) % spacing === 0;
    copy += alter ? (value[at] === "Q" ? "Z" : "Q") : value[at];
  }
  return copy;
}

function fillTo256KiB(copy: string): string {
  let text = copy;
  while (text.length < 256 * 1024) text += copy;
  return text.slice(0, 256 * 1024);
}

/**
 * 256 KiB of near copies of `value`, altered every ninth character. Every
 * run of eight characters hits the index, so this is the densest hit count
 * the scan can see.
 */
function denseHitText(value: string): string {
  return fillTo256KiB(alteredCopy(value, 9));
}

/**
 * 256 KiB of copies of `value` with the last seventh removed. Each copy is
 * one long run, which is what makes a scan that re-walks a run per starting
 * offset quadratic. Dense short hits do not reach that cost, so both
 * shapes are measured.
 */
function longRunText(value: string): string {
  return fillTo256KiB(value.slice(0, Math.floor(value.length * 0.86)));
}

function benignText(): string {
  return fillTo256KiB(BENIGN_SOURCE);
}

beforeEach(() => alertSpy.mockClear());

afterEach(() => {
  for (const id of [
    SESSION,
    "other-session",
    "idem-a",
    "idem-b",
    "perf-benign",
    "perf-near-2k-dense",
    "perf-near-2k-long",
    "perf-near-8k-dense",
    "perf-near-8k-long",
  ]) {
    clearSecurityCredentialSession(id);
  }
});

describe("security credential output tripwire", () => {
  it("blocks plaintext and common transport encodings", () => {
    register(SESSION, ENGAGEMENT, SECRET);
    for (const encoded of [
      SECRET,
      Buffer.from(SECRET).toString("base64"),
      Buffer.from(SECRET).toString("base64url"),
      encodeURIComponent(SECRET),
    ]) {
      expect(sanitizeSecurityCredentialOutput(SESSION, { output: `prefix ${encoded} suffix` })).toBe(
        SECURITY_CREDENTIAL_OUTPUT_BLOCKED,
      );
      expect(sanitizeSecurityCredentialOutput(SESSION, { output: encoded })).toBe(
        SECURITY_CREDENTIAL_OUTPUT_BLOCKED,
      );
      expect(() => assertNoSecurityCredentialOutput(SESSION, encoded)).toThrow(/blocked/);
    }
  });

  it("blocks wrapped and whitespace-separated base64", () => {
    const longSecret = "wrapped-secret-".repeat(12);
    register(SESSION, ENGAGEMENT, longSecret);
    const encoded = Buffer.from(longSecret).toString("base64");
    const wrapped = encoded.match(/.{1,76}/g)?.join("\n") ?? encoded;
    const spaced = encoded.match(/.{1,12}/g)?.join(" \t") ?? encoded;

    expect(sanitizeSecurityCredentialOutput(SESSION, wrapped)).toBe(
      SECURITY_CREDENTIAL_OUTPUT_BLOCKED,
    );
    expect(sanitizeSecurityCredentialOutput(SESSION, spaced)).toBe(
      SECURITY_CREDENTIAL_OUTPUT_BLOCKED,
    );
  });

  it("blocks a split value after unrelated output", () => {
    register(SESSION, ENGAGEMENT, "sentinel-fragment-secret");

    // Both halves are at or above the 8-character minimum fragment.
    expect(sanitizeSecurityCredentialOutput(SESSION, { text: "sentinel-frag" })).toEqual({
      text: "sentinel-frag",
    });
    const filler = { text: "x".repeat(256) };
    expect(sanitizeSecurityCredentialOutput(SESSION, filler)).toEqual(filler);
    expect(sanitizeSecurityCredentialOutput(SESSION, { text: "ment-secret" })).toBe(
      SECURITY_CREDENTIAL_OUTPUT_BLOCKED,
    );
  });

  it("tracks fragments for multiple credentials across unrelated output", () => {
    register(SESSION, ENGAGEMENT, "first-alpha-secret");
    register(SESSION, ENGAGEMENT, "second-beta-token");

    // Both fragments are at or above the 8-character minimum fragment.
    expect(sanitizeSecurityCredentialOutput(SESSION, "second-beta-")).toBe("second-beta-");
    expect(sanitizeSecurityCredentialOutput(SESSION, "x".repeat(256))).toBe("x".repeat(256));
    expect(sanitizeSecurityCredentialOutput(SESSION, "beta-token")).toBe(
      SECURITY_CREDENTIAL_OUTPUT_BLOCKED,
    );
  });

  it("blocks reconstruction when fragments arrive out of order", () => {
    register(SESSION, ENGAGEMENT, "sentinel-secret");

    // The tail arrives first; both fragments clear the 8-character minimum.
    expect(sanitizeSecurityCredentialOutput(SESSION, "result: nel-secret done")).toBe(
      "result: nel-secret done",
    );
    expect(sanitizeSecurityCredentialOutput(SESSION, "unrelated output")).toBe("unrelated output");
    expect(sanitizeSecurityCredentialOutput(SESSION, "prefix sentinel suffix")).toBe(
      SECURITY_CREDENTIAL_OUTPUT_BLOCKED,
    );
  });

  it("blocks a short value split across two fields of one atom", () => {
    // A value at or below the minimum fragment carries no coverage index.
    // The whole-value check has to catch it, and it only does so because it
    // reads the concatenated string leaves as well as the serialized
    // payload: JSON escaping puts a separator between the two fields.
    register(SESSION, ENGAGEMENT, "abcdef");
    expect(sanitizeSecurityCredentialOutput(SESSION, { a: "abc", b: "def" })).toBe(
      SECURITY_CREDENTIAL_OUTPUT_BLOCKED,
    );
  });

  it("does not inspect unrelated sessions and forgets a session on cleanup", () => {
    register(SESSION, ENGAGEMENT, SECRET);
    expect(sanitizeSecurityCredentialOutput("other-session", SECRET)).toBe(SECRET);
    clearSecurityCredentialSession(SESSION);
    expect(sanitizeSecurityCredentialOutput(SESSION, SECRET)).toBe(SECRET);
  });

  it("does not block benign source text", () => {
    register(SESSION, ENGAGEMENT, "correct-horse-battery");
    register(SESSION, ENGAGEMENT, "stg_admin_abc123XYZ");
    register(SESSION, ENGAGEMENT, "A9f3kQ2mZx7LpW0v");

    for (let pass = 0; pass < 3; pass += 1) {
      expect(sanitizeSecurityCredentialOutput(SESSION, BENIGN_SOURCE)).toBe(BENIGN_SOURCE);
    }
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("ignores fragments shorter than the minimum", () => {
    register(SESSION, ENGAGEMENT, VALUE_32);

    // Accepted residual: a persona that drips the value out below the
    // minimum fragment length is not caught. Seven-character chunks carry
    // no window the index can anchor on, so coverage never advances.
    for (let at = 0; at < VALUE_32.length; at += 7) {
      const chunk = VALUE_32.slice(at, at + 7);
      expect(chunk.length).toBeLessThan(MIN_CREDENTIAL_FRAGMENT);
      expect(sanitizeSecurityCredentialOutput(SESSION, chunk)).toBe(chunk);
      expect(sanitizeSecurityCredentialOutput(SESSION, "filler ".repeat(8))).toBe(
        "filler ".repeat(8),
      );
    }
  });

  it("blocks fragments at or above the minimum out of order", () => {
    register(SESSION, ENGAGEMENT, VALUE_32);

    const shuffled = [CHUNKS[2], CHUNKS[0], CHUNKS[3], CHUNKS[1]];
    for (const chunk of shuffled.slice(0, 3)) {
      expect(sanitizeSecurityCredentialOutput(SESSION, chunk)).toBe(chunk);
    }
    expect(sanitizeSecurityCredentialOutput(SESSION, shuffled[3])).toBe(
      SECURITY_CREDENTIAL_OUTPUT_BLOCKED,
    );
  });

  it("remembering the same atom twice does not change coverage", () => {
    register("idem-a", ENGAGEMENT, VALUE_32);
    register("idem-b", ENGAGEMENT, VALUE_32);

    // Session a sees the first chunk three times, session b once. Both must
    // then block on the same later chunk.
    for (let pass = 0; pass < 3; pass += 1) {
      expect(sanitizeSecurityCredentialOutput("idem-a", CHUNKS[0])).toBe(CHUNKS[0]);
    }
    expect(sanitizeSecurityCredentialOutput("idem-b", CHUNKS[0])).toBe(CHUNKS[0]);

    for (const chunk of [CHUNKS[1], CHUNKS[2]]) {
      expect(sanitizeSecurityCredentialOutput("idem-a", chunk)).toBe(chunk);
      expect(sanitizeSecurityCredentialOutput("idem-b", chunk)).toBe(chunk);
    }
    expect(sanitizeSecurityCredentialOutput("idem-a", CHUNKS[3])).toBe(
      SECURITY_CREDENTIAL_OUTPUT_BLOCKED,
    );
    expect(sanitizeSecurityCredentialOutput("idem-b", CHUNKS[3])).toBe(
      SECURITY_CREDENTIAL_OUTPUT_BLOCKED,
    );
  });

  it("alerts once when coverage passes half", () => {
    register(SESSION, ENGAGEMENT, VALUE_32);

    sanitizeSecurityCredentialOutput(SESSION, CHUNKS[0]);
    expect(alertSpy).not.toHaveBeenCalled();
    sanitizeSecurityCredentialOutput(SESSION, CHUNKS[1]);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith({ sessionId: SESSION, engagementId: ENGAGEMENT });
    sanitizeSecurityCredentialOutput(SESSION, CHUNKS[2]);
    expect(alertSpy).toHaveBeenCalledTimes(1);
  });

  it("blocks a copy of the value with one character altered", () => {
    register(SESSION, ENGAGEMENT, VALUE_32);

    // 31 of 32 characters covered, which is at or above the block
    // threshold. Completion alone would miss this: the whole value never
    // appears, so the contiguous check does not see it either.
    const altered = `${VALUE_32.slice(0, 16)}Q${VALUE_32.slice(17)}`;
    expect(altered).not.toBe(VALUE_32);
    expect(sanitizeSecurityCredentialOutput(SESSION, altered)).toBe(
      SECURITY_CREDENTIAL_OUTPUT_BLOCKED,
    );
  });

  it("takes a hit that only partly overlaps a run it already walked", () => {
    // The value carries "1" at positions 8 and 16. The atom is the value
    // with positions 8 to 15 deleted.
    const value = "ABCDEFGH1JKLMNOP1QRSTUVW";
    register(SESSION, ENGAGEMENT, value);

    // At text position 0 the run absorbs the "1" at value position 8 and
    // marks 0 to 8, so the candidate has consumed text through position 9.
    // At text position 8 the window "1QRSTUVW" points at value position 16,
    // one position inside that stretch. Taking it marks 16 to 23, for 17 of
    // 24 covered, which is over the alert threshold. Dropping it leaves 9 of
    // 24, under the threshold and with the whole tail unseen.
    const atom = `${value.slice(0, 8)}${value.slice(16)}`;
    expect(atom).toBe("ABCDEFGH1QRSTUVW");
    expect(sanitizeSecurityCredentialOutput(SESSION, atom)).toBe(atom);
    expect(alertSpy).toHaveBeenCalledTimes(1);
    expect(alertSpy).toHaveBeenCalledWith({ sessionId: SESSION, engagementId: ENGAGEMENT });
  });

  it("does not let a repetitive value starve another value sharing a window", () => {
    // "abababab" starts at many positions of the first value and at position
    // 0 of the second. Without a round-robin over candidates, the first
    // value would use the whole per-position budget, and the second would
    // never be examined at the only text position its fragment offers.
    const repetitive = "ab".repeat(40);
    const shared = "ababababZq7RtWmXb4Yc6VdUe0Tf1SgR";
    register(SESSION, ENGAGEMENT, repetitive);
    register(SESSION, ENGAGEMENT, shared);

    // Exactly one window wide, so the shared value gets one chance.
    expect(sanitizeSecurityCredentialOutput(SESSION, shared.slice(0, 8))).toBe(shared.slice(0, 8));
    // The rest arrives next. Coverage reaches the block threshold only if
    // the first eight characters were credited.
    expect(sanitizeSecurityCredentialOutput(SESSION, shared.slice(8))).toBe(
      SECURITY_CREDENTIAL_OUTPUT_BLOCKED,
    );
  });

  it("misses a copy altered every eighth character", () => {
    register(SESSION, ENGAGEMENT, VALUE_32);

    // Documented residual. No run reaches the eight-character minimum, so
    // coverage stays at zero: the atom is neither blocked nor alerted. The
    // launcher contract and rotation in 1Password are the compensating
    // controls for this shape.
    const altered = alteredCopy(VALUE_32, 8);
    expect(sanitizeSecurityCredentialOutput(SESSION, altered)).toBe(altered);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it("scans 256 KiB of benign text in under 200 ms", () => {
    register("perf-benign", ENGAGEMENT, pemValue(32));
    const text = benignText();

    sanitizeSecurityCredentialOutput("perf-benign", text);
    const started = performance.now();
    expect(sanitizeSecurityCredentialOutput("perf-benign", text)).toBe(text);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("scans 256 KiB of near-miss copies in under 200 ms", () => {
    // The hit path, for a 2 KB and an 8 KB value, in both shapes. Before
    // the scan consumed each text position once per candidate, the long-run
    // shape cost hundreds of milliseconds for the 2 KB value and seconds
    // for the 8 KB one, on the api event loop, and still returned the atom
    // unblocked. A persona can repeat that for free.
    // One session per shape: coverage accumulates, and feeding both shapes
    // to one session would cross the block threshold and stop measuring.
    const values: Array<{ size: string; value: string }> = [
      { size: "2k", value: pemValue(32) },
      { size: "8k", value: pemValue(128) },
    ];
    for (const { size, value } of values) {
      for (const shape of ["dense", "long"] as const) {
        const session = `perf-near-${size}-${shape}`;
        register(session, ENGAGEMENT, value);
        const text = shape === "dense" ? denseHitText(value) : longRunText(value);

        sanitizeSecurityCredentialOutput(session, text);
        const started = performance.now();
        expect(sanitizeSecurityCredentialOutput(session, text)).toBe(text);
        expect(performance.now() - started).toBeLessThan(200);
      }
    }
  });
});
