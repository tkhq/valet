---
name: commit-signing
description: How to get commits signed and shown as Verified on GitHub. Covers signing commits with the user's passkey, the older signing-window mode, and what to do when the user rejects or the key is missing.
---

# Commit signing

Commits you make are unsigned. The user's signing key lives in Turnkey, and the user added its public half to their GitHub account. You never handle a key.

Most accounts sign each commit with the user's passkey. A few accounts use a signing window instead. The tools tell you which: each one answers with the other tool's name when the account uses the other mode.

## Passkey mode (default): `turnkey.sign_commits`

1. Finish the work and commit it normally. The user taps their passkey once per commit, so squash to as few commits as makes sense. The limit is 10. If the repository accepts unsigned pushes on this branch, push first: the card then links each commit's diff on GitHub, so the user can review exactly what they sign.
2. Ask for signatures, naming where the branch starts:

```
call_tool turnkey.sign_commits params={"repo":"owner/name","branch":"my-branch","base":"origin/main"} summary="Sign the 2 commits on my-branch"
```

3. The user sees each commit and signs with their passkey in Valet. On approval the tool rewrites the branch with the signed commits. Commit contents, authors, and times stay the same; the committer email becomes the user's GitHub noreply address.
4. Push: `git push --force-with-lease origin my-branch`.

Run `turnkey.sign_commits` again after any new commit you want signed.

If the push fails because the branch is gone (`src refspec ... does not match any`), the sandbox was replaced after signing. Check out the pushed unsigned branch with `git fetch origin my-branch && git checkout -B my-branch origin/my-branch`, then call `turnkey.sign_commits` again. It reuses the user's approval for the same commits and asks for no new tap.

## Window mode: `turnkey.request_signing_key`

Ask once per pull request, before you commit. On approval git in this sandbox signs every commit until the window ends (2 hours by default).

```
call_tool turnkey.request_signing_key params={"repo":"owner/name","branch":"my-branch","pr_number":123} summary="Sign the commits on my-branch for PR #123"
```

To sign commits made before approval:

```
base=$(git merge-base origin/main HEAD)
git rebase --exec 'git commit --amend --no-edit -S' "$base"
git push --force-with-lease
```

If the user asks to stop signing, call `turnkey.revoke_signing_key` with the fingerprint the request returned.

## When it fails

- The user rejected: stop. Do not call the tool again. Push unsigned only if the user says so.
- The key is not on GitHub, or signing is not set up: tell the user to open Settings, Commit signing, and follow the steps there.
- Window mode, `No signing key for this session`: you committed with signing on before approval. Call `turnkey.request_signing_key`, or commit with `--no-gpg-sign`.
- Window mode, `The session's Turnkey key expired`: the window is over. Ask the user whether to approve a new window.
