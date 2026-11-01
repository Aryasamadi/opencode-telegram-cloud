# OpenCode Telegram Cloud

A GitHub Actions launcher for the **official** OpenCode CLI and the published
`@grinev/opencode-telegram-bot` npm package. This repository is deployment
glue only: it does not fork, patch, or vendor the upstream Telegram bot source.

## What it does

- Installs the latest published npm releases of `@opencode/cli` and
  `@grinev/opencode-telegram-bot` independently on each run.
- Starts an OpenCode V2 server bound to `127.0.0.1` and the Telegram bot on
  the same GitHub-hosted Ubuntu runner.
- Optionally configures your own OpenAI-compatible provider from GitHub
  Actions Secrets; its API key is never written to the repository.
- Restores the previous OpenCode database, bot settings, and workspace files.
- On shutdown, creates an authenticated AES-256-GCM encrypted checkpoint and
  commits only the encrypted file at `.state/agent-state.v1.enc`.

## Required GitHub Actions secrets

Open **Settings → Secrets and variables → Actions → New repository secret**.

| Name | Value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather |
| `TELEGRAM_ALLOWED_USER_ID` | Your numeric Telegram user ID |

Do not put either value in a file, commit, issue, or chat message.

## Add your own AI provider (recommended)

You can use any provider that offers an OpenAI-compatible
`/v1/chat/completions` API. Add these repository secrets:

| Secret name | What to enter |
| --- | --- |
| `AI_PROVIDER_ID` | Short unique ID, e.g. `myprovider` |
| `AI_PROVIDER_NAME` | Display name, e.g. `My Provider` |
| `AI_BASE_URL` | API base URL, usually ending in `/v1` |
| `AI_PROVIDER_API_KEY` | Your provider API key |
| `AI_MODEL_ID` | Exact model ID required by that provider |
| `AI_MODEL_NAME` | Friendly model name |

The four required values are `AI_PROVIDER_ID`, `AI_BASE_URL`,
`AI_PROVIDER_API_KEY`, and `AI_MODEL_ID`. The two display-name values are
optional. If no custom-provider values are supplied, the workflow keeps the
default OpenCode provider/model selection.

The workflow generates a temporary OpenCode config under the runner's temp
directory. The config refers to the key as `{env:AI_PROVIDER_API_KEY}`; the
actual key is injected only into the OpenCode server process from Actions
Secrets. It is not stored in the encrypted state archive or Git history.

This built-in helper currently targets OpenAI-compatible Chat Completions
providers. Providers that require Anthropic Messages, OpenAI Responses, custom
headers, or a special SDK adapter may need a provider-specific configuration
instead. OpenCode supports 75+ providers and custom endpoints; see
https://opencode.ai/docs/providers/.

## Optional OpenCode-hosted provider

If you want to use OpenCode-hosted models instead, set
`OPENCODE_API_KEY` as a repository secret and authenticate for the relevant
OpenCode service. OpenCode's software is open source, but hosted inference has
separate account, model, and usage limits. OpenCode Go is optional and paid;
it is not required when you supply your own provider.

## Run it

1. Add the two required Telegram secrets.
2. Add the four required custom-provider secrets if you want your own model.
3. Open **Actions → OpenCode Telegram Cloud → Run workflow**.
4. Select the `main` branch and start the workflow.
5. While the job is running, open your Telegram bot and send it commands or
   prompts. Use `/open` to browse `/home/runner/projects` and select a project.
6. When the job ends, the workflow saves the encrypted checkpoint. To resume,
   manually start the workflow again from **Actions → Run workflow**.

## Runtime boundaries

This is an **on-demand coding session**, not a 24/7 Telegram hosting service.
The workflow is manual-only and deliberately does not self-trigger an endless
chain of runner jobs. The bot runs for up to 5 hours 55 minutes; the job timeout
is 6 hours to leave a short shutdown/checkpoint window. Each run uses a fresh
hosted runner, and a gap between runs is possible.

The upstream bot currently starts long polling with
`drop_pending_updates: true`. Consequently, Telegram messages sent while no
runner is active may be discarded when the next run starts. The bot receives
messages live while the workflow is running.

## What persists, and what does not

The OpenCode database is restored in place, so existing session IDs, messages,
and OpenCode state are available to the next run. The bot's settings file also
preserves the current project and session selection. The workspace directory
is restored at the same absolute path (`/home/runner/projects`).

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
- The encryption key is derived at runtime from `TELEGRAM_BOT_TOKEN` using
  scrypt; the archive uses AES-256-GCM with authenticated integrity checking.
- Keep the same bot token to decrypt old checkpoints. Before rotating the bot
  token, restore and re-encrypt the checkpoint with the new token.
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
