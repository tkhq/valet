# Secrets with 1Password

Your agent needs credentials to do real work: a GitHub token to open a pull
request, a Stripe key to call an API, an SSH key to reach a host. This guide
shows how to give it those credentials without pasting one into the chat.

Valet stores no secret values. It stores a pointer to an item in 1Password and
a service account token that reads it. Inside a session sandbox, the agent runs
`valet-secrets`, names an environment variable, and the value lands in that one
command. The value never enters the transcript.

## How it works

1. You connect a 1Password service account token in Valet settings.
2. The agent runs `valet-secrets run --env NAME=op://vault/item/field -- cmd`.
3. The command reads the sandbox token, then asks the Valet API to resolve the
   reference.
4. The API reads the value through the 1Password SDK and returns it once.
5. `valet-secrets` puts the value in the environment of `cmd`, removes the
   sandbox token from that environment, and runs `cmd`.

The agent names a destination. It never receives the secret as text, so the
secret stays out of the reply, out of the thread history, and out of the logs
that carry them.

## Connect a token

Every token is a 1Password **service account** token. A service account reads
only the vaults you grant it. Create one vault for Valet, put the items the
agent needs in it, and grant the service account read access to that vault
alone.

In 1Password:

1. Open [1Password in your browser](https://my.1password.com/).
2. Create a vault for the items the agent may read. See
   [Create, share, and manage vaults in your organization](https://support.1password.com/create-share-vaults-teams/).
3. Create a service account and grant it read access to that vault. See
   [Get started with 1Password Service Accounts](https://www.1password.dev/service-accounts/get-started/).
4. Copy the token. 1Password shows it once.

In Valet, a token lives on the page that owns it.

| Token | Where it lives | Who can change it | What it covers |
| --- | --- | --- | --- |
| Personal | Settings → You → Connected accounts | You, always | Your own vaults, for sessions you own |
| Organization | Settings → Organization → 1Password | An org admin | Vaults the whole org shares |
| Team | Settings → Organization → Teams | A team admin | Vaults one team shares |

Each page has a **Connect 1Password** button. It opens the same dialog: the
setup steps, the links into 1Password, and the field for the token.

Every org member can set, replace, and remove a **personal** token. No admin
has to allow it first, and you never need to open Organization settings to do
it.

Only an org admin can set, replace, or remove the **organization** token. The
page shows you whether that token is connected, and names the role that can
change it. If you need an org token, ask an org admin.

## The `op://` reference format

A reference names a vault, an item, and a field:

```
op://<vault>/<item>/<field>
op://<vault>/<item>/<section>/<field>
```

Copy the vault, item, and field titles from 1Password exactly. A segment may
contain a space. A segment may not contain a slash or a control character.

```
op://Engineering/GitHub/token
op://My Vault/Stripe/secret key
op://Shared/AWS/prod/access key id
```

Valet accepts this one grammar
(`OP_REFERENCE` in `packages/api/src/services/onepassword.ts`). A file path, a
URL, or an environment variable name does not match, and the broker refuses it.

If a vault or item title contains a character 1Password rejects in a reference
— an apostrophe is the common case — `valet-secrets find` prints the vault or
item **id** in that segment instead of the title. The reference still resolves.

## Token scopes

A reference resolves through one of three tokens. Valet calls each one a
**scope**.

| Scope | Token owner | Which sessions consult it |
| --- | --- | --- |
| `personal` | You | A session you own, run by you |
| `org` | The organization | Every session in the org |
| `team` | One team | A session that team owns |

The rule that decides this is `onePasswordScopesFor` in
`packages/api/src/services/credential-resolution.ts`, and the same rule governs
the sandbox broker, the session tool path, and the workflow tool node.

| Session or run owner | Scopes consulted, in order |
| --- | --- |
| You (a user-owned session) | `org`, then `personal` |
| A team | `team`, then `org` |
| The org, or an unknown owner | `org` only |

A team-owned or org-owned session never reads your personal vault. The user id
on a session is the actor frozen onto it when it starts, not whoever prompts it
now, and anyone in the group can prompt a shared session. Your private items
stay yours.

One consequence to plan for: a workflow run owned by a team or by the org
cannot read a personal credential. Put the credential in a team vault or an org
vault, or own the run yourself.

### Precedence when more than one token exists

Valet tries the scopes in the order above and takes the first value it gets.

For a session you own, the **org token wins**. If an item with the same name
sits in an org vault and in your personal vault, the org copy answers. Pass
`--scope personal` when you mean your own.

For a team session, a connected team token is authoritative. Valet falls back
to the org token only when the team has **no** token at all. A team token that
is connected and cannot read the item returns an error, not the org's copy.

`--scope` narrows the list. It never widens it. Asking for a scope your session
may not use is refused by name:

```
valet-secrets: This session cannot use a personal 1Password token. Start a session you own personally.
```

## Find a reference

Use `find` when you know what the credential is called but not where it lives.

```
valet-secrets find [--scope org|personal|team] <name>
```

`find` takes exactly one search term. Quote a term that contains a space.

```bash
valet-secrets find claude
valet-secrets find 'google calendar'
valet-secrets find --scope personal github
```

It prints one candidate per line: the scope, a tab, then the reference.

```
org	op://Engineering/GitHub/token
personal	op://My Vault/GitHub Personal/credential
```

`find` prints names only. It never prints a value. It matches an item title on
a word boundary, so `linear` matches "Linear API Key" and does not match
"Linearity". It returns at most 10 items per scope, and the search term must be
200 characters or fewer.

The field segment is the field `find` judges to hold the secret: a field titled
`credential`, `api key`, `token`, `secret`, or `password` first, then any
concealed field, then a one-time code field, then `notesPlain` for a secure
note.

For a session you own, `find` searches the org vaults and your personal vaults
and tags every hit, which is how you learn that you need `--scope`. For a team
session with a team token, `find` searches the team vaults and stops there,
even when it finds nothing.

Ask the agent by name. "Use my Linear key from 1Password" is enough: the
agent runs `find` for you, picks the reference, and uses it. You only need to
name the vault, item, and field when `find` comes back with nothing.

## Use a secret

```
valet-secrets run [--scope org|personal|team] --env NAME=op://vault/item/field [--env ...] -- <command> [args...]
```

Everything after `--` is the command. Repeat `--env` for each variable.

```bash
# One secret
valet-secrets run --env GITHUB_TOKEN=op://Engineering/GitHub/token -- gh pr list

# A reference containing a space: quote the whole pair
valet-secrets run --env TOKEN='op://My Vault/GitHub/token' -- gh pr list

# Two secrets, and an explicit scope
valet-secrets run --scope personal \
  --env AWS_ACCESS_KEY_ID='op://My Vault/AWS/access key id' \
  --env AWS_SECRET_ACCESS_KEY='op://My Vault/AWS/secret access key' \
  -- aws s3 ls

# A private key, byte for byte
valet-secrets run --env KEY=op://Engineering/Deploy/private key -- sh -c 'printf %s "$KEY" > ~/.ssh/id_ed25519'
```

Rules to keep in mind:

- Quote the pair, not just the reference, when a vault or item title has a
  space. `--env TOKEN='op://My Vault/GitHub/token'` is one argument.
- A variable name takes letters, digits, and underscore, and does not start
  with a digit.
- One `run` takes at most 25 references. Each one costs a round trip to
  1Password.
- `run` replaces itself with your command, so the exit code you see is your
  command's exit code.
- If any reference fails, `run` stops and names it. Your command does not
  start with an empty credential.

Do not echo the variable. `valet-secrets` keeps the value out of the reply; a
command that prints it puts it back in.

## Declare a command once, in the repo

A repo can state which command needs which credential. Valet then installs a
wrapper for that command, and the agent runs it as an ordinary command.

Put the declarations in `.valet/credentials.yaml`:

```yaml
commands:
  - command: stripe
    env: STRIPE_API_KEY
    reference: op://Engineering/Stripe/secret key
  - command: aws
    env: AWS_SECRET_ACCESS_KEY
    credential: aws
```

- `command` is a bare command name. It becomes a wrapper ahead of the real
  binary on `PATH`.
- `env` is the variable the real command reads.
- `reference` pins one item. `credential` names it and lets `find` locate it at
  run time. Set exactly one of the two.

The wrapper leaves a credential you already set alone, and it runs the real
command unauthenticated when nothing resolves, so a declaration never breaks a
command that did not need a secret. When `credential` matches more than one
item, the wrapper stops:

```
Multiple 1Password items match. Pin an explicit reference in .valet/credentials.yaml.
```

A declaration is not a grant. The wrapper calls the same broker under the same
scope rule, so a repo cannot name its way into a vault the session could not
already read.

## Errors and exit codes

| Exit | Message | What to do |
| --- | --- | --- |
| 1 | `valet-secrets: base64 is missing from this sandbox. Add coreutils to the sandbox image, then run again.` | Use a sandbox image that carries `base64`. |
| 2 | The usage text | Check the argument order. `--env` pairs come before `--`; the command comes after it. |
| 2 | `valet-secrets: --scope takes org, personal, or team, got: <value>` | Use one of the three scope names. |
| 2 | `valet-secrets: --env expects NAME=reference, got: <arg>` | Write the pair as `NAME=op://vault/item/field`. |
| 2 | `valet-secrets: "<name>" is not a valid variable name. Use letters, digits, and underscore, and do not start with a digit.` | Rename the variable. |
| 2 | `valet-secrets: the reference for <name> contains a control character. Retype it, and check for a stray tab.` | Retype the reference. |
| 3 | `valet-secrets: nothing in 1Password is named like that. Ask the user for the vault, item, and field names.` | `find` matched no item. Try a different term, or ask for the exact names. |
| 3 | `valet-secrets: nothing resolved <ref>. Check the vault, item, and field names in 1Password, and that the session's org has a service account token connected.` | Check the three titles, and check that a token for the scope is connected. |
| 3 | `valet-secrets: <ref> resolved to an empty value. Put a value in that field in 1Password, then run again.` | The field exists and is blank. Fill it in 1Password. |
| 4 | `valet-secrets: could not reach the broker at <url>. Check that the api is running and reachable from this sandbox, then run again.` | The API is down or unreachable from the sandbox. |
| 4 | `valet-secrets: the broker did not answer within 30 seconds. Run it again; if it repeats, check the api logs for a slow 1Password call.` | Run it again. A repeat points at a slow 1Password call. |
| 4 | `valet-secrets: the sandbox token was not accepted. Ask the user to reopen the session so it gets a current token.` | Reopen the session so it gets a current token. |
| 4 | `valet-secrets: this sandbox may not read secrets. Ask the user to check the session's org settings.` | The broker refused the principal. |
| 4 | `valet-secrets: the broker answered HTTP <status>. Check the api logs, then run again.` | Read the API log for that request. |
| 127 | `<name> is not installed in this sandbox image` | A declared wrapper found no real binary. Add it to the image. |

`run` and `find` relay the API's own message when the API sends one, so the
lines below arrive with the `valet-secrets: ` prefix and exit 4.

| Broker message | Meaning |
| --- | --- |
| `this endpoint answers a sandbox only. Run valet-secrets inside a session, or send the session's x-valet-sandbox token.` | The request carried no sandbox token. |
| `not a supported secret reference: <refs>. Use op://vault/item/field.` | One or more references do not match the grammar. The message names every one. |
| `at most 25 references per request` | Split the run. |
| `references must be an array of strings` | A malformed request body. |
| `query must be a non-empty string naming the credential to look for` | `find` needs a search term. It does not list vaults. |
| `query must be 200 characters or fewer` | Shorten the term. |
| `scope must be org, personal, or team` | An unknown `--scope` value reached the API. |
| `This session cannot use a personal 1Password token. Start a session you own personally.` | A shared session asked for the personal scope. |
| `this session cannot use the <scope> scope.` | The owner rule excludes that scope. |
| `Team not found. Start a new team session.` | The session names a team the org no longer has. |
| `Team 1Password could not resolve the reference. Check the team token and its vault permissions.` | The team token is connected and could not read the item. Valet does not fall back to the org token here. |
| `Team 1Password discovery failed. Check the team token and its vault permissions.` | The same failure during `find`. |
| `1Password refused the request. Check the service account token in Organization settings, then run again.` | The token exists and 1Password rejected it. Replace it. |

A missing token for a scope is not an error by itself. Valet tries the next
scope, and you see `nothing resolved <ref>` (exit 3) when no scope answers.

## Where the command is absent

`valet-secrets` exists only in a sandbox that ran credential prep.

- **A coding session** has it, at `/usr/local/bin/valet-secrets`.
- **A workflow session node** has no sandbox prep, so it has no
  `valet-secrets`. Its prompt says so: "This sandbox has no secrets command."
  Give that node the credential through a workflow tool node instead, which
  resolves references on the API side under the same scope rule.
- **Your orchestrator** has no `valet-secrets` either. Ask it for a credential
  and it starts a child session that does have one, and reports what the child
  reports.

The 1Password CLI (`op`) is in no sandbox image. Valet installs a stub at
`/usr/local/bin/op` that explains this and exits 127, so `op item get` returns
a clear message instead of `command not found`:

```
op: the 1Password CLI is not installed in this sandbox, and there is no way to browse a vault from here.
```

You cannot browse a vault from a sandbox. `find` searches by name; that is the
whole discovery surface.

## Limits you need to know

- **The child process can read its own environment.** `valet-secrets` puts the
  value in the command's environment and removes the sandbox token from it.
  The command still runs with the variable set, so `echo $TOKEN` prints the
  secret. The guarantee is that the value skips the transcript, not that the
  agent cannot read it.
- **On a backend with a credentials mount, the sandbox token is also a file.**
  `valet-secrets` removes `VALET_SANDBOX_TOKEN` from the environment, and a
  child can still read `/etc/valet/creds/token`. Treat the command you run as
  trusted code that should not receive extra credentials. It is not a
  boundary.
- **The org token reaches every vault the service account can read.** Any
  member's session resolves org-scoped references through it, with no admin
  step per reference. Scope the service account narrowly in 1Password. That is
  the only place the limit exists.
- **A team token does not revoke the org token.** If the org service account
  can already read a team's vault, connecting a team token does not take that
  access away.
- **The broker returns plaintext values and writes no audit record today.**
- **Another process running as the same user in the sandbox can read the
  value**, from `/proc/<pid>/environ` for the child, or from `curl`'s arguments
  during the request.

## Troubleshooting

**"nothing resolved" and the names look right.** Check which scope answered.
Run `valet-secrets find <name>` and read the scope tag on each line. If the
item is in your personal vault and the org token answered first, add
`--scope personal`.

**A rotated token still fails.** Replace the token in settings rather than
editing the item. Valet keys its caches on a digest of the token, so a
replacement takes effect on the next read.

**The agent says it has no access.** Ask it to print the exact
`valet-secrets` line and the exact error. A guessed reference fails the same
way a real one you cannot reach fails, so the failure alone proves nothing.

**A team workflow cannot see your credential.** That is the rule, not a bug.
Move the item into a team vault, or run the workflow as yourself.

## See more

- `docs/security-model.md` — sandbox isolation and credential handling
- `docs/specs/2026-07-21-onepassword-credentials-design.md` — the credential
  provider and the owner-precedence contract
- `docs/specs/2026-09-01-sandbox-secret-broker-design.md` — the broker,
  `valet-secrets`, and the decisions behind them
- `docs/specs/2026-09-04-team-onepassword-vaults-design.md` — team tokens and
  the team-first rule
