# OpenCode Telegram Cloud

A GitHub Actions launcher for the **official** OpenCode CLI and the published
`@grinev/opencode-telegram-bot` npm package. This repository keeps the upstream Telegram bot package intact in the repository. At runner startup, a small version-checked adapter patches the installed package's compiled command router to add the provider command; it does not maintain a fork or modify upstream source files.

## What it does

- Installs the latest published npm releases of `@opencode/cli` and
  `@grinev/opencode-telegram-bot` independently on each run.
- Starts an OpenCode V2 server bound to `127.0.0.1` and the Telegram bot on
  the same GitHub-hosted Ubuntu runner. The adapter also prevents the bot's
`/opencode_start` and `/opencode_stop` commands from overriding the workflow's
server lifecycle.
- Optionally configures your own OpenAI-compatible provider from GitHub
  Actions Secrets; its API key is never written to the repository.
- Restores the OpenCode session database, Telegram's selected session/project,
  OpenCode model-selection metadata, custom providers, and checkpointed
  workspace files.
- On shutdown, creates an authenticated AES-256-GCM encrypted checkpoint and
  commits only the encrypted file at `.state/agent-state.v1.enc`.

## Required GitHub Actions secrets

Open **Settings → Secrets and variables → Actions → New repository secret**.

| Name | Value |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | Token from @BotFather |
| `TELEGRAM_ALLOWED_USER_ID` | Your numeric Telegram user ID |
| `STATE_ENCRYPTION_KEY` | A stable random secret (at least 32 characters); generate with `openssl rand -hex 32` |

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

The three required values are `AI_PROVIDER_ID`, `AI_BASE_URL`, and
`AI_PROVIDER_API_KEY`. `AI_MODEL_ID` is optional: when omitted, the setup
queries the provider's OpenAI-compatible `/models` endpoint and registers the
returned model IDs. If the endpoint cannot return a usable model list, provide
`AI_MODEL_ID`. The two display-name values are optional.

The provider is merged into the persistent `~/.config/opencode/opencode.json`
after the encrypted checkpoint is restored. Existing OpenCode settings and
other providers are preserved. The API key itself is never written to the
config; it is referenced as `{env:AI_PROVIDER_API_KEY}` and supplied only to
the OpenCode server process. The config is included in the encrypted
checkpoint, so the provider remains available on later runner sessions.

After registration, send `/reload`, then use the upstream bot's existing
`/models` → `Providers` menu. No parallel model picker or custom provider
menu is added. The Cloud adapter also blocks `/opencode_start` and
`/opencode_stop`: GitHub Actions owns the server process and its per-run
password. End the workflow normally to shut down the server.

This setup helper targets OpenAI-compatible `/models` discovery and Chat
Completions-compatible providers. Providers that require Anthropic Messages,
OpenAI Responses, custom headers, or a special SDK adapter need a
provider-specific configuration instead. OpenCode supports 75+ providers and custom endpoints; see
https://opencode.ai/docs/providers/.

## Add a provider from Telegram

While the workflow is running, send the bot this command in its authorized
private chat:

```text
/addmodel "Provider Name" "https://example.com/v1" "model-name" "API_KEY"
```

All four quoted values are required. The provider ID is generated
automatically from the provider name, so use a distinct name for each provider.
The bot attempts to delete the submitted Telegram message before processing
it; if deletion fails, it aborts without registering the provider. The key
therefore briefly passes through Telegram before deletion, then is passed to
the provider manager through a process environment variable. The OpenCode
config stores it in the runner with owner-only file permissions, and the
checkpoint committed to GitHub contains ciphertext only. Use this command
only in the bot's authorized private chat, never in a group or channel.

After a successful registration, send `/reload`, then use the existing
`/models` → `Providers` menu to choose a model. No replacement model picker
is added. Dynamic provider registration currently targets OpenAI-compatible
Chat Completions endpoints. Providers with other protocols or custom auth
requirements need a provider-specific adapter.

## Optional OpenCode-hosted provider

If you want to use OpenCode-hosted models instead, set
`OPENCODE_API_KEY` as a repository secret and authenticate for the relevant
OpenCode service. OpenCode's software is open source, but hosted inference has
separate account, model, and usage limits. OpenCode Go is optional and paid;
it is not required when you supply your own provider.

## Run it

1. Add the required Telegram secrets and `STATE_ENCRYPTION_KEY`.
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

The OpenCode database is restored in place, preserving session IDs and
messages. The Telegram bot's settings file preserves its current project and
session selection. The OpenCode model-selection metadata file under
`~/.local/state/opencode` is also checkpointed. Files under
`/home/runner/projects` are included in the encrypted workspace snapshot;
files outside that directory (including uncommitted edits in the GitHub
checkout directory) are not copied as project files. The new checkpoint
diagnostics report whether the OpenCode database and selected Telegram session
were found before saving and after restoring. Saving is stopped if settings
claim a current session but the database is absent.

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
- The checkpoint key is the independent `STATE_ENCRYPTION_KEY` secret; it is
  never derived from the Telegram bot token. Scrypt derives the AES-256-GCM key,
  and authenticated integrity checking rejects incorrect keys or tampering.
- For a one-time migration from an older checkpoint encrypted with the previous
  bot token, temporarily add `STATE_DECRYPTION_KEY` with that old token as its
  value. Keep `STATE_ENCRYPTION_KEY` set to a new independent random secret.
  Run the workflow once and confirm the checkpoint-save step succeeds; it will
  re-encrypt the restored state with `STATE_ENCRYPTION_KEY`. Then delete
  `STATE_DECRYPTION_KEY` from repository secrets. Future restores automatically
  use `STATE_ENCRYPTION_KEY`, and Telegram bot token rotations no longer affect
  checkpoint recovery. Never paste either secret into chat or commit it.
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
