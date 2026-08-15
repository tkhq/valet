import { describe, expect, it } from "vitest";
import {
  detectRecipe,
  loadPrebuildOverride,
  resolveRecipe,
  generateDockerfile,
  type RecipeStep,
  type ResolvedRecipe,
} from "./recipe.js";

function readerFor(fileMap: Record<string, string>): (path: string) => Promise<string | null> {
  return async (path: string) => (path in fileMap ? fileMap[path] : null);
}

describe("detectRecipe", () => {
  it("returns empty for a repo with no known lockfiles", async () => {
    const steps = await detectRecipe(["README.md", "src/index.ts"], readerFor({}));
    expect(steps).toEqual([]);
  });

  it("detects pnpm-lock.yaml", async () => {
    const steps = await detectRecipe(["pnpm-lock.yaml", "package.json"], readerFor({}));
    expect(steps).toEqual([
      { id: "pnpm-install", lockfile: "pnpm-lock.yaml", command: "pnpm install --frozen-lockfile" },
    ]);
  });

  it("detects package-lock.json", async () => {
    const steps = await detectRecipe(["package-lock.json"], readerFor({}));
    expect(steps).toEqual([{ id: "npm-ci", lockfile: "package-lock.json", command: "npm ci" }]);
  });

  it("detects yarn.lock", async () => {
    const steps = await detectRecipe(["yarn.lock"], readerFor({}));
    expect(steps).toEqual([
      { id: "yarn-install", lockfile: "yarn.lock", command: "yarn install --frozen-lockfile" },
    ]);
  });

  it("detects uv.lock", async () => {
    const steps = await detectRecipe(["uv.lock"], readerFor({}));
    expect(steps).toEqual([{ id: "uv-sync", lockfile: "uv.lock", command: "uv sync" }]);
  });

  it("detects requirements.txt", async () => {
    const steps = await detectRecipe(["requirements.txt"], readerFor({}));
    expect(steps).toEqual([
      { id: "pip-install", lockfile: "requirements.txt", command: "pip install -r requirements.txt" },
    ]);
  });

  it("detects Cargo.lock", async () => {
    const steps = await detectRecipe(["Cargo.lock"], readerFor({}));
    expect(steps).toEqual([{ id: "cargo-fetch", lockfile: "Cargo.lock", command: "cargo fetch" }]);
  });

  it("detects go.sum", async () => {
    const steps = await detectRecipe(["go.sum"], readerFor({}));
    expect(steps).toEqual([
      { id: "go-mod-download", lockfile: "go.sum", command: "go mod download" },
    ]);
  });

  it("composes multiple lockfiles for a monorepo, in matrix order", async () => {
    const steps = await detectRecipe(["pnpm-lock.yaml", "uv.lock", "go.sum"], readerFor({}));
    expect(steps.map((s) => s.id)).toEqual(["pnpm-install", "uv-sync", "go-mod-download"]);
  });

  it("ignores nested (non-root) lockfiles this pass", async () => {
    const steps = await detectRecipe(["packages/foo/pnpm-lock.yaml"], readerFor({}));
    expect(steps).toEqual([]);
  });
});

describe("loadPrebuildOverride", () => {
  it("returns null when .valet/prebuild.yaml is absent", async () => {
    const override = await loadPrebuildOverride(readerFor({}));
    expect(override).toBeNull();
  });

  it("parses image, setup, and skipDetect", async () => {
    const override = await loadPrebuildOverride(
      readerFor({
        ".valet/prebuild.yaml": `image: ghcr.io/acme/base:latest\nsetup:\n  - make bootstrap\n  - echo done\nskipDetect: true\n`,
      }),
    );
    expect(override).toEqual({
      image: "ghcr.io/acme/base:latest",
      setup: ["make bootstrap", "echo done"],
      skipDetect: true,
    });
  });

  it("returns an empty object for an empty file", async () => {
    const override = await loadPrebuildOverride(readerFor({ ".valet/prebuild.yaml": "" }));
    expect(override).toEqual({});
  });

  it("rejects a non-mapping document", async () => {
    await expect(
      loadPrebuildOverride(readerFor({ ".valet/prebuild.yaml": "- just\n- a\n- list\n" })),
    ).rejects.toThrow(/mapping/);
  });

  it("rejects setup entries that aren't strings", async () => {
    await expect(
      loadPrebuildOverride(readerFor({ ".valet/prebuild.yaml": "setup:\n  - 1\n  - 2\n" })),
    ).rejects.toThrow(/setup/);
  });
});

describe("resolveRecipe", () => {
  const files = ["pnpm-lock.yaml"];

  it("with no override, detection runs normally and setup is empty", async () => {
    const resolved = await resolveRecipe(files, readerFor({}));
    expect(resolved).toEqual({
      recipe: [
        { id: "pnpm-install", lockfile: "pnpm-lock.yaml", command: "pnpm install --frozen-lockfile" },
      ],
      setup: [],
      image: undefined,
    });
  });

  it("skipDetect suppresses lockfile detection but keeps setup (setup-only repo)", async () => {
    const resolved = await resolveRecipe(
      files,
      readerFor({
        ".valet/prebuild.yaml": "skipDetect: true\nsetup:\n  - make bootstrap\n",
      }),
    );
    expect(resolved).toEqual({
      recipe: [],
      setup: ["make bootstrap"],
      image: undefined,
    });
  });

  it("without skipDetect, detected steps run first and override setup is appended", async () => {
    const resolved = await resolveRecipe(
      files,
      readerFor({
        ".valet/prebuild.yaml": "setup:\n  - echo extra\n",
      }),
    );
    expect(resolved.recipe.map((s) => s.id)).toEqual(["pnpm-install"]);
    expect(resolved.setup).toEqual(["echo extra"]);
  });

  it("image override is independent of skipDetect", async () => {
    const resolved = await resolveRecipe(
      files,
      readerFor({
        ".valet/prebuild.yaml": "image: ghcr.io/acme/base:latest\n",
      }),
    );
    expect(resolved.image).toBe("ghcr.io/acme/base:latest");
    expect(resolved.recipe.map((s) => s.id)).toEqual(["pnpm-install"]);
  });
});

describe("generateDockerfile", () => {
  const baseOpts = {
    baseImage: "ghcr.io/valet/sandbox-base:v12",
    cloneUrl: "https://github.com/acme/widgets.git",
    commitSha: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
    recipe: [
      { id: "pnpm-install", lockfile: "pnpm-lock.yaml", command: "pnpm install --frozen-lockfile" },
    ] satisfies RecipeStep[],
  };

  it("matches the golden", () => {
    const dockerfile = generateDockerfile(baseOpts);
    expect(dockerfile).toBe(`FROM ghcr.io/valet/sandbox-base:v12

RUN --mount=type=secret,id=git-token sh -c '\\
  printf "#!/bin/sh\\ncase \\"\\$1\\" in\\n  *[Uu]sername*) echo x-access-token ;;\\n  *) cat /run/secrets/git-token ;;\\nesac\\n" > /tmp/valet-git-askpass.sh && \\
  chmod +x /tmp/valet-git-askpass.sh && \\
  GIT_ASKPASS=/tmp/valet-git-askpass.sh git clone "https://github.com/acme/widgets.git" /prebuilt/repo && \\
  rm -f /tmp/valet-git-askpass.sh'

WORKDIR /prebuilt/repo
RUN git checkout a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2

RUN pnpm install --frozen-lockfile

LABEL valet.prebuild.identity="ghcr.io/valet/sandbox-base:v12|https://github.com/acme/widgets.git@a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2|cd49d99c170e343b4954d954a63545c413fdcbc79ba845712717dabf1bba777e"
`);
  });

  it("appends setup commands after recipe steps", () => {
    const dockerfile = generateDockerfile({ ...baseOpts, setup: ["make bootstrap", "echo done"] });
    const recipeIdx = dockerfile.indexOf("RUN pnpm install --frozen-lockfile");
    const setup1Idx = dockerfile.indexOf("RUN make bootstrap");
    const setup2Idx = dockerfile.indexOf("RUN echo done");
    expect(recipeIdx).toBeGreaterThan(-1);
    expect(setup1Idx).toBeGreaterThan(recipeIdx);
    expect(setup2Idx).toBeGreaterThan(setup1Idx);
  });

  it("is deterministic: two calls with the same input are byte-identical", () => {
    const a = generateDockerfile(baseOpts);
    const b = generateDockerfile(baseOpts);
    expect(a).toBe(b);
  });

  it("changing the recipe/setup changes the identity label hash", () => {
    const a = generateDockerfile(baseOpts);
    const b = generateDockerfile({ ...baseOpts, setup: ["echo different"] });
    const hashOf = (s: string) => /valet\.prebuild\.identity="[^"]*\|([0-9a-f]+)"/.exec(s)?.[1];
    expect(hashOf(a)).not.toBe(hashOf(b));
  });

  it("changing a recipe step's command (same id/lockfile) changes the identity hash", () => {
    const a = generateDockerfile(baseOpts);
    const b = generateDockerfile({
      ...baseOpts,
      recipe: [
        {
          id: "pnpm-install",
          lockfile: "pnpm-lock.yaml",
          command: "pnpm install --frozen-lockfile --prod",
        },
      ],
    });
    const hashOf = (s: string) => /valet\.prebuild\.identity="[^"]*\|([0-9a-f]+)"/.exec(s)?.[1];
    expect(hashOf(a)).not.toBe(hashOf(b));
  });

  it("never embeds the secret token — only the mount path and askpass script path", () => {
    const dockerfile = generateDockerfile(baseOpts);
    expect(dockerfile).toContain("/run/secrets/git-token");
    expect(dockerfile).toContain("--mount=type=secret,id=git-token");
    // No ARG or ENV instruction anywhere carries token-shaped material.
    expect(dockerfile).not.toMatch(/^ARG /m);
    expect(dockerfile).not.toMatch(/^ENV /m);
    // The literal word "token" only ever appears as part of the secret id
    // or mount path — never assigned a value of its own.
    expect(dockerfile).not.toMatch(/token[=:]\s*[^/\s"]/i);
  });

  it("askpass script answers the Username prompt with x-access-token and the Password prompt with the mounted secret", () => {
    const dockerfile = generateDockerfile(baseOpts);
    // Case-insensitive branch on the askpass prompt argument ($1): a
    // "Username" prompt gets the literal GitHub App installation-token
    // username, anything else (the password prompt) reads the secret. The
    // script text is embedded in a printf format string nested two shells
    // deep (outer `sh -c '...'`, inner generated script), so `"` and `$`
    // are backslash-escaped in the Dockerfile source to survive the inner
    // shell's parsing and land literally in the generated script file.
    expect(dockerfile).toMatch(/case\s+\\"\\\$1\\"\s+in/);
    expect(dockerfile).toMatch(/\*\[Uu\]sername\*\)/);
    expect(dockerfile).toContain("x-access-token");
    expect(dockerfile).toContain("cat /run/secrets/git-token");
  });

  it("has no recipe steps rendered when recipe is empty (setup-only)", () => {
    const dockerfile = generateDockerfile({ ...baseOpts, recipe: [], setup: ["make bootstrap"] });
    expect(dockerfile).not.toContain("pnpm install");
    expect(dockerfile).toContain("RUN make bootstrap");
  });
});

describe("docker key", () => {
  const read = (yaml: string) => async (p: string) =>
    p === ".valet/prebuild.yaml" ? yaml : null;

  it("parses docker: true", async () => {
    const o = await loadPrebuildOverride(read("docker: true"));
    expect(o?.docker).toBe(true);
  });

  it("rejects a non-boolean docker value with a corrective error", async () => {
    await expect(loadPrebuildOverride(read("docker: yes please"))).rejects.toThrow(
      ".valet/prebuild.yaml: docker must be a boolean",
    );
  });

  it("does not leak into the identity hash inputs", async () => {
    // generateDockerfile's inputs are (baseImage, cloneUrl, commitSha,
    // recipe, setup) — docker is not among them, so two overrides that
    // differ only in `docker` must produce byte-identical Dockerfiles.
    const withDocker = await resolveRecipe([], read("setup: [x]\ndocker: true"));
    const without = await resolveRecipe([], read("setup: [x]"));
    const df = (r: ResolvedRecipe) =>
      generateDockerfile({
        baseImage: "b", cloneUrl: "u", commitSha: "s",
        recipe: r.recipe, setup: r.setup,
      });
    expect(df(withDocker)).toBe(df(without));
  });

  it("resolveRecipe forwards docker", async () => {
    const resolved = await resolveRecipe([], read("docker: true\nskipDetect: true"));
    expect(resolved.docker).toBe(true);
    expect(resolved.recipe).toEqual([]);
  });
});
