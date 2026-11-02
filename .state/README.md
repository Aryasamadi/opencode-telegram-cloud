# Encrypted runtime state

The workflow stores two encrypted generations:

- `agent-state.v1.enc`: the current checkpoint.
- `agent-state.previous.enc`: the immediately preceding known-good checkpoint.

Both files contain authenticated AES-256-GCM ciphertext. The encrypted
archive includes a recovery manifest with its creation time, selected
session/project, included paths, and OpenCode database path. Startup validates
the archive and SQLite database before choosing a generation to restore.

Never commit plaintext archives, database files, configuration directories,
bot tokens, model API keys, or encryption keys here.

The independent `STATE_ENCRYPTION_KEY` GitHub Actions secret encrypts the
checkpoints. It is not derived from the Telegram bot token. Phase 1 checkpoints
without a manifest remain supported as legacy recovery points.
