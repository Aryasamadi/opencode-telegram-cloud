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

## Persistence boundary

The checkpoint preserves:

- OpenCode user data under `~/.local/share/opencode` (including its SQLite
  database and session records)
- OpenCode configuration under `~/.config/opencode`
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

The project path is kept stable at `/home/runner/projects` across hosted
Ubuntu jobs. If the project data is not included in the checkpoint, its
session may be listed but its working directory will not be complete.

## Deliberate limits

The bot runs for at most 355 minutes (5 hours 55 minutes); the enclosing job
timeout is 360 minutes (6 hours) to leave a shutdown/checkpoint window. The
workflow is manual-only and does not chain jobs indefinitely or promise
continuous Telegram polling between jobs. The upstream bot starts polling
with pending updates dropped, so messages sent during an offline gap may not
be delivered to the next run.

The encrypted checkpoint is limited to 95 MiB. A larger snapshot fails closed;
it is not split or partially uploaded.
