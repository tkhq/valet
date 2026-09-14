// @vitest-environment jsdom
/**
 * The controlled config form (spec §Dynamic configuration): focus, invariants,
 * and threat categories are pure controlled fields that fire onChange. No data
 * fetching, no mutation.
 */
import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import type { SecurityCredentialWarningWire } from "@valet/api/wire";
import {
  ConfigForm,
  emptyConfigDraft,
  emptyScopeDraft,
  normalizeScopeHostsForSubmit,
  type ConfigDraft,
} from "./config-form";

function Host({
  initial,
  requireLiveScope,
  credentialWarnings,
}: {
  initial?: Partial<ConfigDraft>;
  requireLiveScope?: boolean;
  credentialWarnings?: SecurityCredentialWarningWire[];
}) {
  const [value, setValue] = useState<ConfigDraft>({
    ...emptyConfigDraft(),
    ...initial,
  });
  return (
    <div>
      <ConfigForm
        value={value}
        onChange={setValue}
        requireLiveScope={requireLiveScope}
        credentialWarnings={credentialWarnings}
      />
      <output data-testid="dump">{JSON.stringify(value)}</output>
    </div>
  );
}

function openAdvanced() {
  fireEvent.click(screen.getByText("Advanced"));
}

function dump(): ConfigDraft {
  return JSON.parse(screen.getByTestId("dump").textContent ?? "{}");
}

describe("ConfigForm", () => {
  it("seeds the fields from the value", () => {
    render(<Host initial={{ focus: "the webhook verifier", categories: ["authz"] }} />);
    openAdvanced();
    expect((screen.getByLabelText("Focus (optional)") as HTMLTextAreaElement).value).toBe(
      "the webhook verifier",
    );
    const authz = screen.getByLabelText("Authorization") as HTMLInputElement;
    expect(authz.checked).toBe(true);
  });

  it("fires onChange when focus changes", () => {
    render(<Host />);
    openAdvanced();
    fireEvent.change(screen.getByLabelText("Focus (optional)"), {
      target: { value: "the token path" },
    });
    expect(dump().focus).toBe("the token path");
  });

  it("adds and edits an invariant", () => {
    render(<Host />);
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: "Add invariant" }));
    fireEvent.change(screen.getByLabelText("Invariant 1"), {
      target: { value: "every admin route sits behind requireAdmin" },
    });
    expect(dump().invariants.map((i) => i.text)).toEqual([
      "every admin route sits behind requireAdmin",
    ]);
  });

  it("toggles a threat category, preserving the KNOWN order", () => {
    render(<Host initial={{ categories: ["webhooks"] }} />);
    fireEvent.click(screen.getByLabelText("Authorization"));
    // authz precedes webhooks in KNOWN_CATEGORIES, so it leads.
    expect(dump().categories).toEqual(["authz", "webhooks"]);
    // Untoggle webhooks.
    fireEvent.click(screen.getByLabelText("Webhooks"));
    expect(dump().categories).toEqual(["authz"]);
  });

  it("renders the scope section and adds a host", () => {
    render(<Host />);
    // Section header is always present, even without live personas.
    expect(screen.getByTestId("config-scope")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add host" }));
    fireEvent.change(screen.getByLabelText("Authorized host 1"), {
      target: { value: "api.example.com" },
    });
    expect(dump().scope.hosts).toEqual(["api.example.com"]);
  });

  it("shows the REQUIRED hint and empty-scope error when live persona is in the plan", () => {
    render(<Host requireLiveScope={true} />);
    expect(screen.getByTestId("config-scope-required")).toBeTruthy();
    expect(screen.getByTestId("config-scope-empty")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add host" }));
    fireEvent.change(screen.getByLabelText("Authorized host 1"), {
      target: { value: "api.example.com" },
    });
    // Once a host is added, the empty-scope error clears.
    expect(screen.queryByTestId("config-scope-empty")).toBeNull();
  });

  it("removes a scope host without collapsing the others", () => {
    render(
      <Host
        initial={{
          scope: { ...emptyScopeDraft(), hosts: ["a.example.com", "b.example.com"] },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Remove host 1" }));
    expect(dump().scope.hosts).toEqual(["b.example.com"]);
  });
});

describe("ConfigForm credentials (Advanced)", () => {
  it("hides credentials by default under Advanced", () => {
    render(<Host />);
    expect(screen.queryByLabelText(/op:\/\/ reference/i)).toBeNull();
  });

  it("shows credentials after opening Advanced", () => {
    render(<Host />);
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    expect(screen.getByLabelText(/label/i)).toBeTruthy();
    expect(screen.getByLabelText(/op:\/\/ reference/i)).toBeTruthy();
  });

  it("adds a credential row and fires onChange", () => {
    render(<Host />);
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    expect(dump().credentials).toHaveLength(1);
  });

  it("removes a credential row", () => {
    render(<Host />);
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    fireEvent.change(screen.getByLabelText("Credential 1 label"), {
      target: { value: "alpha" },
    });
    fireEvent.change(screen.getByLabelText("Credential 2 label"), {
      target: { value: "beta" },
    });
    expect(dump().credentials).toHaveLength(2);
    fireEvent.click(screen.getAllByRole("button", { name: /remove credential/i })[0]);
    // The survivor is "beta" (the second row), confirmed both in the draft
    // and in the one remaining rendered input.
    expect(dump().credentials).toHaveLength(1);
    expect(dump().credentials[0].label).toBe("beta");
    expect((screen.getByLabelText("Credential 1 label") as HTMLInputElement).value).toBe("beta");
  });

  it("shows the Ref shape toggle only for kind toolAuth", () => {
    render(<Host />);
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    for (const kind of ["password", "session", "headerToken", "mtls", "signingKey", "testData"]) {
      fireEvent.change(screen.getByLabelText("Credential 1 kind"), { target: { value: kind } });
      expect(screen.queryByLabelText("Credential 1 ref shape")).toBeNull();
    }
    fireEvent.change(screen.getByLabelText("Credential 1 kind"), { target: { value: "toolAuth" } });
    expect(screen.getByLabelText("Credential 1 ref shape")).toBeTruthy();
  });

  it("rejects an invalid op:// reference client-side, with the server's own message", () => {
    render(<Host />);
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    fireEvent.change(screen.getByLabelText(/op:\/\/ reference/i), {
      target: { value: "not-a-ref" },
    });
    expect(screen.getByText(/is not a valid op:\/\/ path/i)).toBeTruthy();
    // The message shows the form to use and a working example, so the fix
    // needs no second lookup.
    expect(screen.getByText(/op:\/\/vault\/item\/field/i)).toBeTruthy();
  });

  it("refuses a reserved label client-side, before the create round trip", () => {
    render(<Host />);
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    fireEvent.change(screen.getAllByLabelText(/label/i)[0], { target: { value: "valet-secrets" } });
    expect(screen.getByText(/reserved by sandbox prep/i)).toBeTruthy();
  });

  it("accepts a lowercase env name, matching the server rule", () => {
    render(<Host />);
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    fireEvent.change(screen.getByLabelText(/credential 1 env/i), { target: { value: "adminToken" } });
    expect(screen.queryByText(/invalid env name/i)).toBeNull();
  });

  it("flags a duplicate env name across credential rows, as the server would", () => {
    render(<Host />);
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    fireEvent.change(screen.getByLabelText(/credential 1 env/i), {
      target: { value: "ADMIN_PASSWORD" },
    });
    fireEvent.change(screen.getByLabelText(/credential 2 env/i), {
      target: { value: "ADMIN_PASSWORD" },
    });
    expect(screen.getAllByText(/reuses the env name "ADMIN_PASSWORD"/i)).toHaveLength(2);
    // The message carries the fix and a working example, same as the server's.
    expect(screen.getAllByText(/unique env name/i)).toHaveLength(2);
  });

  it("does not flag distinct env names", () => {
    render(<Host />);
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    fireEvent.change(screen.getByLabelText(/credential 1 env/i), {
      target: { value: "ADMIN_PASSWORD" },
    });
    fireEvent.change(screen.getByLabelText(/credential 2 env/i), {
      target: { value: "ADMIN_API_TOKEN" },
    });
    expect(screen.queryByText(/reuses the env name/i)).toBeNull();
  });

  it("flags a duplicate label across credential rows", () => {
    render(<Host />);
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    const labelInputs = screen.getAllByLabelText(/label/i);
    fireEvent.change(labelInputs[0], { target: { value: "admin-login" } });
    fireEvent.change(labelInputs[1], { target: { value: "admin-login" } });
    expect(screen.getAllByText(/duplicate label/i)).toHaveLength(2);
    // Every refusal carries a working example, so the fix needs no lookup.
    expect(screen.getAllByText(/for example "admin-login"/i)).toHaveLength(2);
  });

  it("names the row's own label in a field refusal once that label is valid", () => {
    render(<Host />);
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    fireEvent.change(screen.getByLabelText("Credential 1 label"), {
      target: { value: "admin-login" },
    });
    fireEvent.change(screen.getByLabelText("Credential 1 env"), { target: { value: "1BAD" } });
    expect(screen.getByText(/Credential "admin-login" has an invalid env name/)).toBeTruthy();
  });

  it("never shows the internal probe label in a refusal", () => {
    render(<Host />);
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    fireEvent.change(screen.getByLabelText("Credential 1 op:// reference"), {
      target: { value: "not-a-ref" },
    });
    expect(screen.queryByText(/"probe"/)).toBeNull();
    expect(screen.getByText(/^A credential has a reference/)).toBeTruthy();
  });
});

describe("ConfigForm credentials copy", () => {
  it("says what a credential is and where the value stays", () => {
    render(<Host />);
    openAdvanced();
    expect(
      screen.getByText(
        /A credential is a secret the review needs to log in or call an API, for example an admin password or an API token\./,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Valet never stores the value\./)).toBeTruthy();
  });

  it("expands the op:// help into three steps and one example", () => {
    render(<Host />);
    openAdvanced();
    const toggle = screen.getByRole("button", { name: "How do I find an op:// reference?" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByTestId("credential-reference-help")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const help = screen.getByTestId("credential-reference-help");
    expect(help.querySelectorAll("li")).toHaveLength(3);
    expect(help.textContent).toContain("Open the item in 1Password.");
    expect(help.textContent).toContain("Open the menu on the field you want.");
    expect(help.textContent).toContain("Choose Copy Secret Reference.");
    expect(help.textContent).toContain("op://Security/Staging admin/password");
  });

  it("shows one plain sentence for each credential kind", () => {
    const expected: [string, string][] = [
      [
        "password",
        "A login password. The persona gets it as an environment variable inside its launcher command.",
      ],
      ["session", "A cookie value that keeps a logged-in session."],
      ["headerToken", "A bearer or API token sent in an HTTP header."],
      [
        "mtls",
        "A client certificate and key for mutual TLS. Declare the certificate reference in the certificate field below.",
      ],
      ["signingKey", "A private key used to sign requests."],
      [
        "toolAuth",
        "Credentials a tool reads as a block, for example a JSON service account. Choose Ref shape json when the 1Password field holds JSON.",
      ],
      ["testData", "Non-secret test values such as a payment card number the fuzzer may send."],
    ];
    render(<Host />);
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    for (const [kind, sentence] of expected) {
      fireEvent.change(screen.getByLabelText("Credential 1 kind"), { target: { value: kind } });
      expect(screen.getByTestId("credential-kind-help-0").textContent).toBe(sentence);
    }
  });

  it("explains raw and json next to the Ref shape select", () => {
    render(<Host />);
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    fireEvent.change(screen.getByLabelText("Credential 1 kind"), { target: { value: "toolAuth" } });
    expect(
      screen.getByText(
        "raw passes the field text as is. json parses it and exports each key as its own variable.",
      ),
    ).toBeTruthy();
  });

  it("says the label is a name the persona sees, never a value", () => {
    render(<Host />);
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    expect(screen.getByText("The persona sees this name, never the value.")).toBeTruthy();
    expect(
      (screen.getByLabelText("Credential 1 label") as HTMLInputElement).placeholder,
    ).toBe("admin-login");
    expect((screen.getByLabelText("Credential 1 env") as HTMLInputElement).placeholder).toBe(
      "ADMIN_PASSWORD",
    );
  });
});

describe("ConfigForm mTLS certificate reference", () => {
  it("shows the certificate field only for the mTLS kind", () => {
    render(<Host />);
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    for (const kind of ["password", "session", "headerToken", "signingKey", "toolAuth", "testData"]) {
      fireEvent.change(screen.getByLabelText("Credential 1 kind"), { target: { value: kind } });
      expect(screen.queryByLabelText("Credential 1 certificate reference")).toBeNull();
    }
    fireEvent.change(screen.getByLabelText("Credential 1 kind"), { target: { value: "mtls" } });
    expect(screen.getByLabelText("Credential 1 certificate reference")).toBeTruthy();
  });

  it("stores a valid certificate reference on meta.certRef", () => {
    render(<Host />);
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    fireEvent.change(screen.getByLabelText("Credential 1 kind"), { target: { value: "mtls" } });
    fireEvent.change(screen.getByLabelText("Credential 1 certificate reference"), {
      target: { value: "op://Security/Partner/cert" },
    });
    expect(dump().credentials[0].meta).toEqual({ certRef: "op://Security/Partner/cert" });
  });

  it("refuses a certificate reference that is not an op:// path, with an example", () => {
    render(<Host />);
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    fireEvent.change(screen.getByLabelText("Credential 1 kind"), { target: { value: "mtls" } });
    fireEvent.change(screen.getByLabelText("Credential 1 certificate reference"), {
      target: { value: "not-a-ref" },
    });
    // Not a bare /certificate reference/: the field's own Label carries that
    // phrase too, and a two-element match fails getByText.
    expect(screen.getByText(/an invalid certificate reference/i)).toBeTruthy();
    expect(screen.getByText(/op:\/\/Security\/Partner\/cert/)).toBeTruthy();
  });

  it("drops the certificate reference when the kind moves away from mTLS", () => {
    render(<Host />);
    openAdvanced();
    fireEvent.click(screen.getByRole("button", { name: /add credential/i }));
    fireEvent.change(screen.getByLabelText("Credential 1 kind"), { target: { value: "mtls" } });
    fireEvent.change(screen.getByLabelText("Credential 1 certificate reference"), {
      target: { value: "op://Security/Partner/cert" },
    });
    fireEvent.change(screen.getByLabelText("Credential 1 kind"), { target: { value: "password" } });
    expect(dump().credentials[0].meta).toBeUndefined();
  });
});

describe("ConfigForm credential warnings", () => {
  const warnings: SecurityCredentialWarningWire[] = [
    {
      label: "admin-login",
      message:
        'Reference "op://Security/Staging admin/password" did not resolve. Check the vault, item, and field names in 1Password.',
    },
  ];

  it("shows the label, the remedy, and the caption", () => {
    render(<Host credentialWarnings={warnings} />);
    const box = screen.getByTestId("credential-warning-admin-login");
    expect(box.textContent).toContain('Credential "admin-login" could not be verified:');
    expect(box.textContent).toContain("Check the vault, item, and field names in 1Password.");
    expect(box.textContent).toContain(
      "Fix this before you start the review, or the start will fail with the same message.",
    );
  });

  it("opens Advanced so a warning is never hidden", () => {
    render(<Host credentialWarnings={warnings} />);
    expect(screen.getByTestId("config-advanced")).toBeTruthy();
  });

  it("shows no warning box when the preview reports none", () => {
    render(<Host />);
    openAdvanced();
    expect(screen.queryByTestId("credential-warning-admin-login")).toBeNull();
  });
});

describe("normalizeScopeHostsForSubmit", () => {
  it("trims, drops empties, and dedups while preserving the original order", () => {
    expect(
      normalizeScopeHostsForSubmit({
        ...emptyScopeDraft(),
        hosts: [" api.example.com ", "", "staging.example.com", "api.example.com"],
      }),
    ).toEqual(["api.example.com", "staging.example.com"]);
  });

  it("returns an empty list when every host is blank", () => {
    expect(
      normalizeScopeHostsForSubmit({ ...emptyScopeDraft(), hosts: ["", " ", "\t"] }),
    ).toEqual([]);
  });
});
