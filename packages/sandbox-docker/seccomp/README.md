# Browser container seccomp profile

`browser.json` derives from the Playwright v1.63.0 Docker seccomp profile:
<https://github.com/microsoft/playwright/blob/v1.63.0/utils/docker/seccomp_profile.json>.
Playwright distributes that source under Apache-2.0.

The profile adds `mount`, `umount2`, `pivot_root`, `sethostname`, and `chroot` for unprivileged Bubblewrap mount namespaces.
The upstream profile already permits the user namespace calls that Chromium needs.
Other unlisted syscalls keep the upstream `SCMP_ACT_ERRNO` default.
The browser provider does not use an unconfined profile or a privileged container.

Docker loads this profile from the provider package.
Kubernetes uses the node-local path `valet/browser.json` beneath the kubelet seccomp directory.
Use [the browser deployment guide](../../../deploy/browser.md) to install it.
