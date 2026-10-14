# Valet CLI for NixOS.
#
# The release binary is a Bun `--compile` executable. It is dynamically linked
# against glibc and expects the loader at /lib64/ld-linux-x86-64.so.2 (or
# /lib/ld-linux-aarch64.so.1). NixOS has no such path.
#
# We do not patch the binary. Bun appends its payload to the end of the ELF
# file, and patchelf moves data around the ELF headers, which can break the
# payload lookup. Instead we run the unmodified release binary inside an FHS
# sandbox (buildFHSEnv, bubblewrap) that provides the standard loader path.
# This needs unprivileged user namespaces, which NixOS enables by default.
#
# The binary stays dynamically linked. This is a NixOS-compatible package, not
# a static executable.
{ lib, stdenvNoCC, fetchurl, buildFHSEnv, cacert }:

let
  version = "0.1.0";

  # Release assets of tkhq/valet tag valet/v${version}.
  # Update with `nix/update.sh <version>`.
  assets = {
    x86_64-linux = {
      name = "valet-linux-x64";
      hash = "sha256-APYZ4RjzFrbU9ryXtVWucn5as7CSVK8RWFA01YQxfEI=";
    };
    aarch64-linux = {
      name = "valet-linux-arm64";
      hash = "sha256-VOBv9v/s/BLkSYpLWFtDiCcMaOEKGL9EC5QmRVuq4SY=";
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
in
(buildFHSEnv {
  pname = "valet";
  inherit version;
  # buildFHSEnv always provides glibc and the standard loader path.
  targetPkgs = _: [ cacert ];
  runScript = "${unwrapped}/bin/valet";

  meta = {
    description = "Valet CLI (Bun-compiled release binary run in an FHS environment)";
    homepage = "https://github.com/tkhq/valet";
    license = lib.licenses.mit;
    mainProgram = "valet";
    platforms = builtins.attrNames assets;
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}).overrideAttrs (old: {
  passthru = (old.passthru or { }) // { inherit unwrapped; };
})
