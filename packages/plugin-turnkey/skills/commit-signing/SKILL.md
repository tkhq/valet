---
name: commit-signing
description: How to get commits signed and shown as Verified on GitHub. Covers when to ask for a signing key, how to rewrite a branch with signed commits, and what to do when the user rejects or the key expires.
---

# Commit signing

Commits you make are unsigned until the user approves a signing key. The key lives in Turnkey. Git in this sandbox signs through it once `turnkey.request_signing_key` has been approved.

## When to ask

Ask once per pull request, when the branch is ready for review. Do not ask before the work is done: the key is valid for a window (2 hours by default) and is deleted after it.

```
call_tool turnkey.request_signing_key params={"repo":"owner/name","branch":"my-branch","pr_number":123} summary="Sign the commits on my-branch for PR #123"
```

The user sees the repository, the branch, and the window, and approves or rejects. On approval the tool configures git in this sandbox. You do not handle a key.

## After approval

Rewrite the branch so every commit is signed, then push:

```
base=$(git merge-base origin/main HEAD)
git rebase --exec 'git commit --amend --no-edit -S' "$base"
git push --force-with-lease
```

Use the pull request's base branch in place of `origin/main`. Say in the pull request that you rewrote the branch to sign it.

New commits after approval are signed on their own while the window is open.

## When it fails

- The user rejected: stop. Do not call the tool again. Push unsigned only if the user says so.
- `No signing key for this session`: you committed with signing on before approval. Call `turnkey.request_signing_key`, or commit with `--no-gpg-sign`.
- `The session's Turnkey key expired`: the window is over. Ask the user whether to approve a new key.
- `Signing needs approval in Valet`: the user must approve in Valet, then commit again.

## Revoking early

If the user asks to stop signing, call `turnkey.revoke_signing_key` with the fingerprint the request returned. Commits after that are unsigned.
