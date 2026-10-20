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
# security tracker). Keep `--use-system-ca` until Node and Bun bundled stores
# are also patched.
set -eu

ROOTS='emSign_ECC_Root_CA_-_G3 Comodo_AAA_Services_root'

sed -i \
  -e 's|^mozilla/emSign_ECC_Root_CA_-_G3.crt|!&|' \
  -e 's|^mozilla/Comodo_AAA_Services_root.crt|!&|' \
  /etc/ca-certificates.conf
update-ca-certificates --fresh

# Fail the build if either root is still in the system store.
for f in $ROOTS; do
  if [ -e "/etc/ssl/certs/$f.pem" ]; then
    echo "distrust-compromised-roots: $f still trusted" >&2
    exit 1
  fi
done
# Fail if the sed patterns no longer match (conf renamed upstream).
for f in $ROOTS; do
  grep -q "^!mozilla/$f.crt" /etc/ca-certificates.conf || {
    echo "distrust-compromised-roots: $f entry not disabled in ca-certificates.conf" >&2
    exit 1
  }
done

if [ "${1:-}" = "--chromium-policy" ]; then
  dir=/etc/opt/chrome_for_testing/policies/managed
  mkdir -p "$dir"
  sep=''
  {
    printf '{"CADistrustedCertificates":['
    for f in $ROOTS; do
      printf '%s"%s"' "$sep" "$(sed -e '/-----/d' "/usr/share/ca-certificates/mozilla/$f.crt" | tr -d '\n')"
      sep=','
    done
    printf ']}\n'
  } > "$dir/valet-distrust-compromised-roots.json"
  chmod 0644 "$dir/valet-distrust-compromised-roots.json"
fi
