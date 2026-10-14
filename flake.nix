{
  description = "Valet CLI packaged for NixOS";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.05";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];
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
