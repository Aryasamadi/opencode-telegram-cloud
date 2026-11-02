# Encrypted runtime state

The workflow writes the latest encrypted checkpoint to:

`agent-state.v1.enc`

Only authenticated AES-256-GCM ciphertext belongs in this directory. Never
commit plaintext archives, database files, configuration directories, bot
tokens, model API keys, or encryption keys here.

The independent `STATE_ENCRYPTION_KEY` GitHub Actions secret encrypts the
checkpoint. It is not derived from the Telegram bot token.
