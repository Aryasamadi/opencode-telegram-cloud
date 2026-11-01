# Architecture

## One job, one temporary machine

A manual `workflow_dispatch` starts one GitHub-hosted Ubuntu job. It restores
the encrypted checkpoint, installs the current published OpenCode CLI and
Telegram npm package, optionally configures a custom model provider, starts
OpenCode V2 on loopback, and launches the bot.

The server password is generated randomly for each job and passed to both
processes as an environment variable. It is not stored in the repository or
checkpoint.

## Custom provider configuration

When the optional provider secrets are supplied, the setup helper merges the
provider into the persistent `~/.config/opencode/opencode.json` after restoring
the encrypted checkpoint. Existing settings and provider entries are retained.
If `AI_MODEL_ID` is omitted, the helper queries the provider's OpenAI-compatible
`/models` endpoint and registers the returned IDs. The API key is represented
as `{env:AI_PROVIDER_API_KEY}`; the key itself is never written to the config.

The config directory is already part of the encrypted checkpoint. On the next
runner, the provider config is restored before OpenCode starts. The upstream
Telegram bot's existing `/models` → `Providers` menu reads this catalog
directly; this controller does not create a parallel picker.

## Telegram command adapter

The runtime adapter patches the installed published package after `npm install`.
It adds the exact four-quoted-argument form
`/addmodel "Provider Name" "https://example.com/v1" "model-name" "API_KEY"`.
The provider ID is generated from the provider name, and duplicate generated
IDs are rejected rather than silently replacing an existing provider.

CI downloads the actual latest npm tarball, applies the patch, and syntax-checks
the patched distribution. The adapter fails closed if the upstream compiled
command-router anchors change. It also replaces `/opencode_start` and
`/opencode_stop` with a notice: GitHub Actions owns this runner's OpenCode
server and its per-run random password, so Telegram commands must not restart
or stop that process.
## Dynamic provider manager

`scripts/provider-manager.mjs` provides the persistence layer for adding,
listing, and removing multiple OpenAI-compatible providers. It merges provider
entries into the existing OpenCode config and can discover model IDs through
the provider's `/models` endpoint when an explicit model ID is not supplied.
It does not create a second Telegram model menu: the upstream `/models`
provider picker remains the intended UI.

For providers added dynamically, the API key is stored in the local OpenCode
config with file permissions restricted to the runner account. This is
necessary to support multiple independent provider credentials. The config
directory is included in the AES-256-GCM checkpoint, so the copy committed to
the public repository is encrypted ciphertext, not plaintext config. The
Telegram command adapter that invokes this manager is a separate integration
step; the manager CLI alone does not register a Telegram command.

## Persistence boundary

The checkpoint preserves:

- OpenCode user data under `~/.local/share/opencode` (including its SQLite
  database and session records)
- OpenCode configuration under `~/.config/opencode`, excluding the ephemeral
  `service.json` file (it can contain a stale runner PID/password)
- OpenCode model-selection metadata under `~/.local/state/opencode/model.json`
- Telegram bot settings, including its current project/session selection
- User workspaces under `~/projects`

The bot's own `.env`, logs, process IDs, and temporary runtime files are not
archived. GitHub Actions Secrets inject credentials only into the relevant
steps. The archive is encrypted before it is written into the checked-out
repository.

## Continuity

Restoring the same OpenCode database and bot settings allows the bot to
reconnect to the existing session instead of creating a new session and
re-injecting an exported transcript. OpenCode may still include relevant prior
messages in normal model requests and may compact context; session recovery
does not remove ordinary model context/token use.

Project files under `/home/runner/projects` are included in the snapshot.
The workflow's own GitHub checkout directory is refreshed by checkout rather
than restored as a user workspace; uncommitted edits made there are not part of
the checkpoint. A session can still exist in the OpenCode database even when
its corresponding external workspace files are absent.

## Deliberate limits

The bot runs for at most 355 minutes (5 hours 55 minutes); the enclosing job
timeout is 360 minutes (6 hours) to leave a shutdown/checkpoint window. The
workflow is manual-only and does not chain jobs indefinitely or promise
continuous Telegram polling between jobs. The upstream bot starts polling
with pending updates dropped, so messages sent during an offline gap may not
be delivered to the next run.

The encrypted checkpoint is limited to 95 MiB. A larger snapshot fails closed;
it is not split or partially uploaded.
