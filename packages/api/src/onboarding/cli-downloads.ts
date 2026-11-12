import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { Hono } from "hono";
import { stream } from "hono/streaming";
import { publicUrlFromEnv } from "../channels/host.js";
import type { AppEnv } from "../env.js";

const RELEASE = "https://github.com/tkhq/valet/releases/download/dev-v2-latest";
const ASSET = /^valet-(darwin|linux)-(arm64|x64)$/;

/** Only an HTTP origin belongs in the installer, never credentials or a shell fragment. */
function installerOrigin(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== "/") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** POSIX shell: the command shown in the web guide works with `| sh`. */
function installer(origin: string): string {
  return `#!/bin/sh
set -eu
download_base=${shellQuote(`${origin}/cli/downloads/`)}
install_dir="\${VALET_INSTALL_DIR:-$HOME/.local/bin}"
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) echo 'Valet supports macOS and Linux. On Windows, run this command in WSL.' >&2; exit 1 ;;
esac
case "$(uname -m)" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64) arch=x64 ;;
  *) echo 'This CPU is not supported. Ask your Valet admin for a compatible CLI.' >&2; exit 1 ;;
esac
asset="valet-$os-$arch"
temp_dir="$(mktemp -d)"
trap 'rm -rf "$temp_dir"' EXIT HUP INT TERM
echo "Downloading $asset from Valet..."
curl -fL --retry 2 -o "$temp_dir/valet" "$download_base$asset"
chmod 755 "$temp_dir/valet"
if ! "$temp_dir/valet" proxy list >/dev/null 2>&1; then
  echo 'This CLI does not support proxy setup. Ask your Valet admin to publish the matching CLI.' >&2
  exit 1
fi
mkdir -p "$install_dir"
# Stage on the destination filesystem, so replacing an existing CLI is atomic.
staged="$(mktemp "$install_dir/.valet-install.XXXXXX")"
trap 'rm -rf "$temp_dir"; rm -f "$staged"' EXIT HUP INT TERM
cp "$temp_dir/valet" "$staged"
chmod 755 "$staged"
mv -f "$staged" "$install_dir/valet"
echo "Installed valet to $install_dir/valet"
case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "Add $install_dir to PATH before running valet." ;;
esac
echo ${shellQuote(`Next: valet login ${origin}`)}
echo 'Then: valet proxy setup <tool>'
`;
}

/** Serve the CLI that matches an instance's setup guide. Local artifacts are opt-in. */
export function mountCliDownloadRoutes(app: Hono<AppEnv>): void {
  app.get("/cli/install.sh", (c) => {
    const origin = installerOrigin(publicUrlFromEnv(process.env) ?? new URL(c.req.url).origin);
    c.header("Cache-Control", "no-store");
    if (!origin) return c.text("The public Valet URL is invalid. Ask your Valet admin to set VALET_PUBLIC_URL to an HTTP or HTTPS origin.", 503);
    c.header("Content-Type", "text/x-shellscript; charset=utf-8");
    return c.body(installer(origin));
  });

  app.get("/cli/downloads/:asset", async (c) => {
    const asset = c.req.param("asset");
    if (!ASSET.test(asset)) return c.text("CLI target not found. Use the installer at /cli/install.sh.", 404);
    c.header("Cache-Control", "no-store");
    const dir = process.env.VALET_CLI_DOWNLOAD_DIR;
    if (!dir) return c.redirect(`${RELEASE}/${asset}`, 302);
    const path = join(dir, asset);
    const info = await stat(path).catch(() => undefined);
    if (!info?.isFile()) return c.text("This CLI target is not published. Ask your Valet admin to publish the matching CLI.", 503);
    c.header("Content-Type", "application/octet-stream");
    c.header("Content-Disposition", `attachment; filename="${asset}"`);
    c.header("Content-Length", String(info.size));
    return stream(c, async (body) => {
      const file = createReadStream(path);
      body.onAbort(() => { file.destroy(); });
      try {
        for await (const chunk of file) await body.write(chunk);
      } finally {
        file.destroy();
      }
    });
  });
}
