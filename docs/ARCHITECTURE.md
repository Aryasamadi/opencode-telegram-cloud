# Architecture

## One job, one temporary machine

A manual `workflow_dispatch` starts one GitHub-hosted Ubuntu job. It restores
the encrypted checkpoint, installs the current published OpenCode CLI and
Telegram npm package, starts OpenCode V2 on loopback, and launches the bot.

The server password is generated randomly for each job and passed to both
processes as an environment variable. It is not stored in the repository or
checkpoint.

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

The workflow is manual-only, runs for approximately 5 hours 25 minutes, and
then shuts down cleanly and checkpoints. It does not chain jobs indefinitely
or promise continuous Telegram polling between jobs. The upstream bot starts
polling with pending updates dropped, so messages sent during an offline gap
may not be delivered to the next run.

The encrypted checkpoint is limited to 95 MiB. A larger snapshot fails closed;
it is not split or partially uploaded.
