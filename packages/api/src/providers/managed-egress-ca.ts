import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID, X509Certificate } from "node:crypto";

const exec = promisify(execFile);

export interface EphemeralManagedEgressCa {
  caCert: string;
  caKey: string;
}

/** Generates one process-local sandbox CA and removes all temporary files. */
export async function generateEphemeralManagedEgressCa(tempRoot = tmpdir()): Promise<EphemeralManagedEgressCa> {
  const directory = await mkdtemp(join(tempRoot, "valet-managed-egress-ca-"));
  const certPath = join(directory, "ca.crt");
  const keyPath = join(directory, "ca.key");
  try {
    await exec("openssl", [
      "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes",
      "-days", "2", "-subj", `/CN=Valet Managed Egress ${randomUUID()}`,
      "-addext", "basicConstraints=critical,CA:TRUE",
      "-addext", "keyUsage=critical,keyCertSign,cRLSign",
      "-keyout", keyPath, "-out", certPath,
    ]);
    const material = { caCert: await readFile(certPath, "utf8"), caKey: await readFile(keyPath, "utf8") };
    new X509Certificate(material.caCert);
    return material;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
