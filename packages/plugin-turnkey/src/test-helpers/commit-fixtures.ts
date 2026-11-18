/**
 * A throwaway Ed25519 test key and two commits that `git commit -S` signed
 * with it (gpg.format=ssh). Ed25519 signatures are deterministic, so signing
 * the same bytes with the same key must reproduce git's objects exactly.
 */
import { createPrivateKey, sign } from "node:crypto";
import { gitObjectId } from "../commits.js";

export const SEED_HEX = "a3e70e5abd5593e7699a1f41fdc2bb5330ba8fd80ecea998ed5208b84a0a6b6d";
export const PUBLIC_HEX = "a566cf95f0afa9e5eb24a4ec33eb0bb8006f0a10d5a117d902deed5737323036";
export const EMAIL = "valet@example.com";

export const SIGNED_1 = `tree aaff74984cccd156a469afa7d9ab10e4777beb24
author Valet Test <valet@example.com> 1700000000 +0000
committer Valet Test <valet@example.com> 1700000000 +0000
gpgsig -----BEGIN SSH SIGNATURE-----
 U1NIU0lHAAAAAQAAADMAAAALc3NoLWVkMjU1MTkAAAAgpWbPlfCvqeXrJKTsM+sLuABvCh
 DVoRfZAt7tVzcyMDYAAAADZ2l0AAAAAAAAAAZzaGE1MTIAAABTAAAAC3NzaC1lZDI1NTE5
 AAAAQCebL9KRGienFksw2SOyJTtwQwI3YFW4IIzUuvGUrZTctUh/CzJUPpoAN9+SgX4Yja
 Qjw+FlmfpSsnF1CeSqXAs=
 -----END SSH SIGNATURE-----

first commit
`;
export const SIGNED_1_SHA = "64ac927a566dd76098fbf8baea22104a5471aa2a";
export const SIGNED_2_SHA = "f0d6ef6ec1db10b0b92ca65c71afa4a11aa58604";

export const UNSIGNED_1 = `tree aaff74984cccd156a469afa7d9ab10e4777beb24
author Valet Test <valet@example.com> 1700000000 +0000
committer Valet Test <other@example.org> 1700000000 +0000

first commit
`;

export function unsigned2(parent: string): string {
  return `tree 3683f870be446c7cc05ffaef9fa06415276e1828
parent ${parent}
author Valet Test <valet@example.com> 1700000100 +0000
committer Valet Test <other@example.org> 1700000100 +0000

second commit

body line
`;
}

const key = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(SEED_HEX, "hex")]),
  format: "der",
  type: "pkcs8",
});
export const signWithTestKey = (payload: Buffer) => sign(null, payload, key);


export const UNSIGNED_1_SHA = gitObjectId(UNSIGNED_1);
export const UNSIGNED_2 = unsigned2(UNSIGNED_1_SHA);
export const UNSIGNED_2_SHA = gitObjectId(UNSIGNED_2);
