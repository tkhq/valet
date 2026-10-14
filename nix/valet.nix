# Valet CLI for NixOS.
#
# The release binary is a Bun `--compile` executable. It is dynamically linked
# against glibc and expects the loader at /lib64/ld-linux-x86-64.so.2.
# NixOS has no such path.
#
# We do not patch the binary. Bun appends its payload to the end of the ELF
# file, and patchelf moves data around the ELF headers, which can break the
# payload lookup. Instead we run the unmodified release binary inside an FHS
# sandbox (buildFHSEnv, bubblewrap) that provides the standard loader path.
# This needs unprivileged user namespaces, which NixOS enables by default.
#
# The binary stays dynamically linked. This is a NixOS-compatible package, not
# a static executable.
#
# Signals: see the comment on `fhs` below. The package's bin/valet is a small
# wrapper that forwards SIGTERM, SIGINT, SIGHUP and SIGQUIT to Valet.
{ lib, stdenvNoCC, fetchurl, buildFHSEnv, writeShellApplication, procps, cacert }:

let
  version = "0.1.0";

  # Release assets of tkhq/valet tag valet/v${version}.
  # Only x86_64-linux: the v0.1.0 linux-arm64 asset does not run (its embedded
  # sharp module lacks the linux-arm64 native binary).
  # Update with `nix/update.sh <version>`.
  assets = {
    x86_64-linux = {
      name = "valet-linux-x64";
      hash = "sha256-APYZ4RjzFrbU9ryXtVWucn5as7CSVK8RWFA01YQxfEI=";
    };
  };

  asset = assets.${stdenvNoCC.hostPlatform.system}
    or (throw "valet: unsupported system ${stdenvNoCC.hostPlatform.system}");

  unwrapped = stdenvNoCC.mkDerivation {
    pname = "valet-unwrapped";
    inherit version;

    src = fetchurl {
      url = "https://github.com/tkhq/valet/releases/download/valet/v${version}/${asset.name}";
      inherit (asset) hash;
    };
    dontUnpack = true;

    # Keep the release binary byte-for-byte. strip and patchelf in the default
    # fixup phase would corrupt the Bun payload.
    dontFixup = true;

    installPhase = ''
      runHook preInstall
      install -Dm755 $src $out/bin/valet
      runHook postInstall
    '';
  };

  # The FHS launcher (bubblewrap). Two behaviors matter for signals:
  # - bwrap stays alive as the parent of Valet and has no signal handlers, so a
  #   SIGTERM sent to it kills it and does not reach Valet.
  # - With --die-with-parent, bwrap's death then SIGKILLs Valet, so Valet's
  #   graceful shutdown never runs. dieWithParent is off to avoid that.
  # The wrapper below forwards signals to Valet instead.
  fhs = buildFHSEnv {
    pname = "valet-fhs";
    inherit version;
    # buildFHSEnv always provides glibc and the standard loader path.
    targetPkgs = _: [ cacert ];
    runScript = "${unwrapped}/bin/valet";
    dieWithParent = false;
  };
in
(writeShellApplication {
  name = "valet";
  runtimeInputs = [ procps ];
  text = ''
    # Forward termination signals to Valet (the child of bwrap) so its
    # graceful shutdown runs. If Valet is not up yet, signal bwrap itself.
    forward() {
      local target
      target="$(pgrep -P "$launcher" | head -n1 || true)"
      kill "-$1" "''${target:-$launcher}" 2>/dev/null || true
    }

    # Explicit <&0: a background job would otherwise get /dev/null as stdin.
    ${fhs}/bin/valet-fhs "$@" <&0 &
    launcher=$!
    for sig in TERM INT HUP QUIT; do
      # shellcheck disable=SC2064
      trap "forward $sig" "$sig"
    done

    # A trapped signal interrupts wait with status > 128. Wait again until the
    # launcher is gone, then report Valet's exit status.
    while :; do
      status=0
      wait "$launcher" || status=$?
      if [ "$status" -gt 128 ] && kill -0 "$launcher" 2>/dev/null; then continue; fi
      exit "$status"
    done
  '';

  meta = {
    description = "Valet CLI (Bun-compiled release binary run in an FHS environment)";
    homepage = "https://github.com/tkhq/valet";
    license = lib.licenses.mit;
    mainProgram = "valet";
    platforms = builtins.attrNames assets;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}).overrideAttrs (old: {
  passthru = (old.passthru or { }) // { inherit unwrapped fhs; };
})
