#!/bin/sh
# INCIDENT: 2026-10-20 eMudhra intermediate CA private-key compromise
# (https://emudhra.we-have-a-problem.com/). The compromised intermediates chain
# to the roots "emSign ECC Root CA - G3" and "Comodo AAA Services root".
# Browsers already block them; clients using a static CA bundle do not.
#
# This script distrusts both roots in the Debian system store. Run as root,
# after `ca-certificates` is installed.
#
# With `--chromium-policy` it also writes a Chrome managed policy
# (CADistrustedCertificates) for Playwright's Chrome for Testing, which ships its
# own Chrome Root Store and ignores the system store. Playwright installs this
# browser under the "chrome_for_testing" policy directory.
#
# REMOVAL CONDITION: delete this script and every `distrust-compromised-roots`
# line in the Dockerfiles once the Debian bookworm `ca-certificates` package
# ships the distrust (check `apt-cache policy ca-certificates` and the Debian
# security tracker). Keep `--use-openssl-ca` (the safe flag) until Node and Bun bundled stores
# are also patched. `--use-system-ca` only adds to Node's bundled store and does
# not remove the bad roots.
set -eu

ROOTS='emSign_ECC_Root_CA_-_G3 Comodo_AAA_Services_root'

# SHA-256 fingerprints of the two distrusted roots, from roots.json on the
# incident site (https://emudhra.we-have-a-problem.com/). Uppercase hex, no colons.
FP_EMSIGN_G3=86A1ECBA089C4A8D3BBE2734C612BA341D813E043CF9E8A862CD5C57A36BBE6B
FP_COMODO_AAA=D7A7A0FB5D7E2731D771E9484EBCDEF71D5F0C3E0A2948782BC83EE0EA699EF4
BAD_FPS="$FP_EMSIGN_G3 $FP_COMODO_AAA"

fail() {
  echo "distrust-compromised-roots: $*" >&2
  exit 1
}

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

# Print the SHA-256 fingerprint of one cert file (PEM or DER per $2) in
# uppercase hex without colons. Fails if the file is not a valid cert.
cert_fp() {
  out=$(openssl x509 -inform "${2:-PEM}" -in "$1" -noout -fingerprint -sha256) ||
    return 1
  out=${out#*=}
  printf '%s\n' "$out" | tr -d ':'
}

# Fail if any PEM block in a file (single cert or bundle) is a distrusted root.
# Every "-----BEGIN" block is fingerprinted with `openssl x509`, which reads
# CERTIFICATE, TRUSTED CERTIFICATE and X509 CERTIFICATE blocks as they are.
# A block that is unterminated or that openssl cannot parse as a certificate
# fails the build. It is never skipped.
check_pem_file() {
  rm -rf "$work/split"
  mkdir "$work/split"
  awk -v d="$work/split" '
    /-----BEGIN / {
      if (out != "") exit 3
      n++; out = d "/" n ".pem"
    }
    out != "" { print > out }
    /-----END / { out = "" }
    END { if (out != "") exit 3 }' "$1" ||
    fail "$1 has an unterminated or unreadable PEM block"
  for c in "$work"/split/*.pem; do
    [ -e "$c" ] || continue
    fp=$(cert_fp "$c") || fail "cannot fingerprint a PEM block in $1"
    for bad in $BAD_FPS; do
      [ "$fp" != "$bad" ] || fail "distrusted root $bad still present in $1"
    done
  done
}

# The source certs must be the expected roots before we trust them as inputs.
check_source() {
  src="/usr/share/ca-certificates/mozilla/$1.crt"
  [ -s "$src" ] || fail "source certificate $src is missing"
  fp=$(cert_fp "$src") || fail "$src is not a valid certificate"
  [ "$fp" = "$2" ] || fail "$src has unexpected fingerprint $fp"
}
check_source emSign_ECC_Root_CA_-_G3 "$FP_EMSIGN_G3"
check_source Comodo_AAA_Services_root "$FP_COMODO_AAA"

sed -i \
  -e 's|^mozilla/emSign_ECC_Root_CA_-_G3.crt|!&|' \
  -e 's|^mozilla/Comodo_AAA_Services_root.crt|!&|' \
  /etc/ca-certificates.conf
update-ca-certificates --fresh

# Fail the build if the sed patterns no longer match (conf renamed upstream).
for f in $ROOTS; do
  grep -q "^!mozilla/$f.crt" /etc/ca-certificates.conf ||
    fail "$f entry not disabled in ca-certificates.conf"
done

# Fail the build if either root is in the final bundle or the hashed dir, under
# any filename. Compare by certificate fingerprint, not by name.
check_pem_file /etc/ssl/certs/ca-certificates.crt
for f in /etc/ssl/certs/*; do
  [ -f "$f" ] || continue
  check_pem_file "$f"
done

if [ "${1:-}" = "--chromium-policy" ]; then
  dir=/etc/opt/chrome_for_testing/policies/managed
  policy="$dir/valet-distrust-compromised-roots.json"
  mkdir -p "$dir"
  sep=''
  : > "$work/policy.json"
  printf '{"CADistrustedCertificates":[' >> "$work/policy.json"
  for f in $ROOTS; do
    src="/usr/share/ca-certificates/mozilla/$f.crt"
    openssl x509 -in "$src" -outform DER -out "$work/$f.der" ||
      fail "cannot convert $src to DER"
    b64=$(base64 -w0 "$work/$f.der") || fail "cannot encode $f"
    [ -n "$b64" ] || fail "empty policy entry for $f"
    printf '%s"%s"' "$sep" "$b64" >> "$work/policy.json"
    sep=','
  done
  printf ']}\n' >> "$work/policy.json"

  # Verify each entry decodes to one of the expected roots.
  seen=''
  for b64 in $(tr -d '\n' < "$work/policy.json" | sed -e 's/^{"CADistrustedCertificates":\[//' -e 's/\]}$//' -e 's/[",]/ /g'); do
    printf '%s' "$b64" | base64 -d > "$work/entry.der" ||
      fail "policy entry is not valid base64"
    fp=$(cert_fp "$work/entry.der" DER) || fail "policy entry is not a valid certificate"
    case " $BAD_FPS " in
      *" $fp "*) seen="$seen $fp" ;;
      *) fail "policy entry has unexpected fingerprint $fp" ;;
    esac
  done
  for bad in $BAD_FPS; do
    case "$seen" in
      *"$bad"*) ;;
      *) fail "policy is missing root $bad" ;;
    esac
  done

  install -m 0644 "$work/policy.json" "$policy"
fi
