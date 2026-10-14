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
