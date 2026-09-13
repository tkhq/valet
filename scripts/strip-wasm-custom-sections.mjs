import { readFileSync, writeFileSync } from "node:fs";

const path = process.argv[2];
if (!path) throw new Error("Specify the WASM artifact to normalize.");

const bytes = readFileSync(path);
const output = [bytes.subarray(0, 8)];
let offset = 8;

while (offset < bytes.length) {
  const sectionStart = offset;
  const sectionId = bytes[offset++];
  let size = 0;
  let shift = 0;
  let byte;
  do {
    byte = bytes[offset++];
    size |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);

  const sectionEnd = offset + size;
  if (sectionEnd > bytes.length) throw new Error("WASM section exceeds the artifact size.");
  if (sectionId !== 0) output.push(bytes.subarray(sectionStart, sectionEnd));
  offset = sectionEnd;
}

writeFileSync(path, Buffer.concat(output));
