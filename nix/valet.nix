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
# Signals and process lifetime: see the comments on `run` and the wrapper below.
#
# `binary` replaces the packaged executable. Tests use it to run a probe
# program through the same wrapper (see packages.valet-signal-probe in flake.nix).
{ lib
, stdenvNoCC
, fetchurl
, buildFHSEnv
, writeShellApplication
, writeShellScript
, procps
, coreutils
, util-linux
, cacert
, binary ? null
}:

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

  unwrapped = if binary != null then binary else stdenvNoCC.mkDerivation {
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

  setpriv = lib.getExe' util-linux "setpriv";
  env = lib.getExe' coreutils "env";

  # Runs inside the FHS sandbox, as a child of the bwrap monitor process.
  #
  # PR_SET_PDEATHSIG is set to SIGTERM, so Valet gets a graceful SIGTERM when
  # the bwrap monitor dies for any reason, including SIGKILL of the wrapper
  # (the wrapper starts bwrap with the same setting, see below). bwrap's own
  # --die-with-parent sends SIGKILL, which would skip Valet's shutdown handler,
  # so it is off (dieWithParent = false).
  #
  # Race: if the monitor died before the prctl call, no signal is sent. The
  # monitor exports its pid as VALET_FHS_PARENT. After the prctl call we check
  # that our parent is still that process, and exit if it is not.
  #
  # The launcher (bwrap) is a background job of the wrapper, so it runs with
  # SIGINT and SIGQUIT ignored. That keeps it alive when a terminal sends
  # Ctrl-C or Ctrl-\ to the process group while Valet handles it. Ignored
  # signals stay ignored across exec, so env resets both to the default here.
  start = writeShellScript "valet-fhs-start" ''
    if [ "$PPID" != "''${VALET_FHS_PARENT:-}" ]; then
      echo "valet: launcher exited during startup" >&2
      exit 143
    fi
    unset VALET_FHS_PARENT
    exec ${env} --default-signal=INT,QUIT ${unwrapped}/bin/valet "$@"
  '';

  run = writeShellScript "valet-fhs-run" ''
    exec ${setpriv} --pdeathsig TERM -- ${start} "$@"
  '';

  # The FHS launcher (bubblewrap). The bwrap monitor process stays alive as
  # the parent of Valet and has no signal handlers.
  fhs = buildFHSEnv {
    pname = "valet-fhs";
    inherit version;
    # buildFHSEnv always provides glibc and the standard loader path.
    targetPkgs = _: [ cacert ];
    runScript = run;
    dieWithParent = false;
    # The script ends with `exec bwrap`, so $$ is the bwrap monitor pid.
    extraPreBwrapCmds = "export VALET_FHS_PARENT=$$";
  };
in
(writeShellApplication {
  name = "valet";
  runtimeInputs = [ procps coreutils util-linux ];
  # SC2317: forward() runs from traps. SC2016: the bash -c script is single-quoted on purpose.
  excludeShellChecks = [ "SC2317" "SC2016" ];
  text = ''
    # Signal behavior (each point is covered by nix/test-signals.sh):
    # - SIGTERM and SIGHUP go to Valet, so its graceful shutdown runs. Until
    #   Valet is up, they go to the launcher instead.
    # - SIGINT and SIGQUIT are not forwarded. A terminal sends them to the
    #   whole process group, so Valet already gets them. The wrapper only
    #   needs to survive them and keep waiting. A kill -INT sent to the
    #   wrapper pid alone is therefore not delivered to Valet.
    # - If this wrapper dies (even SIGKILL), the launcher gets SIGTERM, and
    #   then Valet does (see `start`), so nothing keeps the port or data lock.
    valet_pid=""
    find_valet() {
      pgrep -P "$launcher" -x valet 2>/dev/null | head -n1 || true
    }
    forward() {
      [ -n "$valet_pid" ] || valet_pid="$(find_valet)"
      kill "-$1" "''${valet_pid:-$launcher}" 2>/dev/null || true
    }

    # Race: if this wrapper died before the prctl call in setpriv, no signal
    # is sent. The inner shell checks that its parent is still this process.
    # Explicit <&0: a background job would otherwise get /dev/null as stdin.
    ${setpriv} --pdeathsig TERM -- "$BASH" -c '
      if [ "$PPID" != "$1" ]; then exit 143; fi
      shift
      exec "$@"
    ' bash "$$" ${fhs}/bin/valet-fhs "$@" <&0 &
    launcher=$!

    trap 'forward TERM' TERM
    trap 'forward HUP' HUP
    # A trap with a handler (not "ignore") keeps this shell alive and waiting
    # while Valet handles the signal.
    trap : INT QUIT

    # Learn Valet's pid early. A SIGTERM that also kills bwrap (a service
    # manager signals every process in the group) leaves Valet running its
    # shutdown, and this script must wait for it.
    for _ in $(seq 1 40); do
      valet_pid="$(find_valet)"
      if [ -n "$valet_pid" ] || ! kill -0 "$launcher" 2>/dev/null; then break; fi
      sleep 0.05
    done

    # A trapped signal interrupts wait with status > 128. Wait again until the
    # launcher is gone.
    while :; do
      status=0
      wait "$launcher" || status=$?
      if [ "$status" -gt 128 ] && kill -0 "$launcher" 2>/dev/null; then continue; fi
      break
    done

    # bwrap died first but Valet is still shutting down: wait for it.
    if [ -n "$valet_pid" ]; then
      while kill -0 "$valet_pid" 2>/dev/null; do sleep 0.1; done
    fi
    exit "$status"
  '';

  meta = {
    description = "Valet CLI (Bun-compiled release binary run in an FHS environment)";
    homepage = "https://github.com/tkhq/valet";
    license = lib.licenses.mit;
    mainProgram = "valet";
    platforms = [ "x86_64-linux" ];
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}).overrideAttrs (old: {
  passthru = (old.passthru or { }) // { inherit unwrapped fhs; };
})
