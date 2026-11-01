# Encrypted runtime state

The workflow writes the latest encrypted checkpoint to:

`agent-state.v1.enc`

Only authenticated AES-256-GCM ciphertext belongs in this directory. Never
commit plaintext archives, database files, configuration directories, bot
tokens, model API keys, or encryption keys here.

The encryption key is derived at runtime from the `TELEGRAM_BOT_TOKEN`
repository secret. The token itself is not written into this directory.
