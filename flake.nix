{
  description = "Valet CLI packaged for NixOS";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";

  outputs = { self, nixpkgs }:
    let
      # aarch64-linux is not offered: the valet/v0.1.0 linux-arm64 binary fails on
      # every command (embedded sharp has no linux-arm64 native module). Add it
      # back once a release with a working arm64 binary is pinned.
      systems = [ "x86_64-linux" ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      packages = forAll (pkgs: rec {
        valet = pkgs.callPackage ./nix/valet.nix { };
        valet-unwrapped = valet.unwrapped;

        # The same wrapper around a probe program instead of Valet. Tests use
        # it to check signal dispositions, stdin, exit codes and parent-death
        # cleanup without depending on what Valet does with signals.
        valet-signal-probe = pkgs.callPackage ./nix/valet.nix {
          executableOverride = pkgs.writeShellScriptBin "valet" ''
            case "$1" in
              sleep)
                echo "probe-ready $(grep SigIgn /proc/self/status)" >&2
                exec ${pkgs.coreutils}/bin/sleep 31337 ;;
              cat) exec ${pkgs.coreutils}/bin/cat ;;
              exit) exit "$2" ;;
              args) shift; printf '[%s]\n' "$@" ;;
            esac
          '';
        };
        default = valet;
      });

      apps = forAll (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.system}.valet}/bin/valet";
        };
      });

      overlays.default = final: _prev: {
        valet = final.callPackage ./nix/valet.nix { };
      };
    };
}
