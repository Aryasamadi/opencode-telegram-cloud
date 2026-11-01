# OpenCode Telegram Cloud

A GitHub Actions launcher for the **official** OpenCode CLI and the published
`@grinev/opencode-telegram-bot` npm package. This repository is deployment
glue only: it does not fork, patch, or vendor the upstream Telegram bot source.

## What it does

- Installs the latest published npm releases of `@opencode/cli` and
  `@grinev/opencode-telegram-bot` independently on each run.
- Starts an OpenCode V2 server bound to `127.0.0.1` and the Telegram bot on
  the same GitHub-hosted Ubuntu runner.
- Restores the previous OpenCode database, bot settings, and workspace files.
- On shutdown, creates an authenticated AES-256-GCM encrypted checkpoint and
  commits only the encrypted file at `.state/agent-state.v1.enc`.

The encrypted checkpoint includes OpenCode's user data/database, OpenCode
configuration, the Telegram bot's `settings.json` (+ backup and local commands),
and `~/projects`. It intentionally excludes the bot's `.env`, runtime PID
files, logs, dependency folders, and common build/cache folders.

## Required GitHub Actions secrets

Open **Settings → Secrets and variables → Actions → New repository secret**
and add:

| Name | Value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather |
| `TELEGRAM_ALLOWED_USER_ID` | Your numeric Telegram user ID |

Do not put either value in a file, commit, issue, or chat message.

The checkpoint key is derived from `TELEGRAM_BOT_TOKEN` using scrypt; the
archive uses AES-256-GCM with a fresh random salt and nonce and authenticated
integrity checking. No separate encryption-key secret is required. **Keep the
same bot token to decrypt old checkpoints.** Before rotating the bot token,
restore and re-encrypt the checkpoint with the new token, or the old state
cannot be decrypted.

An optional `OPENCODE_API_KEY` repository secret is passed through when
configured. The Telegram bot can start without it, but actual AI responses
require an enabled OpenCode model/provider. Current OpenCode documentation
notes that the signed-out `opencode` provider is unavailable until an OpenCode
Console account is connected or `OPENCODE_API_KEY` is configured. The default
model values here (`opencode` / `big-pickle`) are starter defaults, not a
promise of anonymous model access.

## Run it

1. Add the two required secrets above.
2. Open **Actions → OpenCode Telegram Cloud → Run workflow**.
3. Select the `main` branch and start the workflow.
4. While the job is running, open your Telegram bot and send it commands or
   prompts. Use `/open` to browse `/home/runner/projects` and select a project.
5. When the job ends, the workflow saves the encrypted checkpoint. To resume,
   manually start the workflow again from **Actions → Run workflow**.

## Runtime boundaries

This is an **on-demand coding session**, not a 24/7 Telegram hosting service.
The workflow is manual-only and deliberately does not self-trigger an endless
chain of runner jobs. GitHub Actions is not being used as a permanent server.
The bot is kept alive for about 5 hours 25 minutes; the job has a 5 hour 55
minute safety timeout so it has time to shut down and checkpoint. Each run uses
a fresh hosted runner, and a gap between runs is possible.

The upstream bot currently starts long polling with
`drop_pending_updates: true`. Consequently, Telegram messages sent while no
runner is active may be discarded when the next run starts. The bot receives
messages live while the workflow is running.

## What persists, and what does not

The OpenCode database is restored in place, so existing session IDs, messages,
and OpenCode state are available to the next run. The bot's settings file also
preserves the current project and session selection. The workspace directory is
restored at the same absolute path (`/home/runner/projects`).

This prevents the workflow from rebuilding a session by injecting a copied
transcript into a brand-new session. It does **not** mean future model calls use
zero context or zero tokens: OpenCode still supplies relevant session context
to the model as part of normal inference and may compact it according to its
own rules.

The encrypted state file is capped at 95 MiB to stay below GitHub's per-file
limit. If your database or projects exceed that, the save step fails rather
than silently uploading a partial checkpoint. Git history also retains old
encrypted versions, so repeated large checkpoints can grow repository size.

## Security notes

- The repository is public; the checkpoint file is ciphertext only.
- The encryption key is never written to the repository or workflow logs.
- GitHub's temporary `GITHUB_TOKEN` receives only `contents: write` for this
  repository so the workflow can commit the encrypted checkpoint.
- The OpenCode server listens only on loopback. A fresh random server password
  is generated for each run and is not checkpointed.
- The workflow only runs on manual dispatch; it does not execute code from
  pull requests or arbitrary public events.

## Upstream projects

- Telegram client: https://github.com/grinev/opencode-telegram-bot
- npm package: https://www.npmjs.com/package/@grinev/opencode-telegram-bot
- OpenCode CLI: https://github.com/anomalyco/opencode
- OpenCode docs: https://opencode.ai/docs/
