#!/usr/bin/env node
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  open as openFile,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const MAGIC = Buffer.from("OCTSTATE");
const VERSION = 1;
const HEADER_LENGTH = 8 + 1 + 16 + 12;
const TAG_LENGTH = 16;
const MAX_ENCRYPTED_BYTES = 95 * 1024 * 1024;
const STATE_RELATIVE_PATH = ".state/agent-state.v1.enc";

function getStateEncryptionKey() {
  const key = process.env.STATE_ENCRYPTION_KEY;
  if (!key || key.trim().length < 32) {
    throw new Error(
      "STATE_ENCRYPTION_KEY is missing or too short; set a stable secret of at least 32 characters.",
    );
  }
  return key;
}

function getStateDecryptionKey() {
  const key = process.env.STATE_DECRYPTION_KEY || process.env.STATE_ENCRYPTION_KEY;
  if (!key || key.trim().length < 20) {
    throw new Error(
      "STATE_DECRYPTION_KEY or STATE_ENCRYPTION_KEY is missing; state cannot be decrypted.",
    );
  }
  return key;
}

function deriveKey(token, salt) {
  // Telegram bot tokens are high-entropy credentials. Scrypt derives a separate
  // 256-bit state key; the random salt is stored with each encrypted snapshot.
  return scryptSync(`opencode-telegram-cloud-state-v1:${token}`, salt, 32, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

function encrypt(plain, token) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv]);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(token, salt), iv);
  cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([header, cipher.getAuthTag(), ciphertext]);
}

function decrypt(encrypted, key) {
  if (encrypted.length < HEADER_LENGTH + TAG_LENGTH) {
    throw new Error("Encrypted state file is truncated.");
  }
  if (
    !encrypted.subarray(0, 8).equals(MAGIC) ||
    encrypted[8] !== VERSION
  ) {
    throw new Error("Encrypted state file has an unknown format/version.");
  }

  const header = encrypted.subarray(0, HEADER_LENGTH);
  const salt = encrypted.subarray(9, 25);
  const iv = encrypted.subarray(25, 37);
  const tag = encrypted.subarray(37, 53);
  const ciphertext = encrypted.subarray(53);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    deriveKey(token, salt),
    iv,
  );
  decipher.setAAD(header);
  decipher.setAuthTag(tag);
  // Authentication completes before any archive extraction is attempted.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function runTar(args) {
  execFileSync("tar", args, { stdio: "inherit" });
}

function getXdgHome(home, variable, ...fallbackParts) {
  return path.resolve(process.env[variable] || path.join(home, ...fallbackParts));
}

function getBotHome(home) {
  const configured = process.env.OPENCODE_TELEGRAM_HOME?.trim();
  return path.resolve(configured || path.join(getXdgHome(home, "XDG_CONFIG_HOME", ".config"), "opencode-telegram-bot"));
}

function getDatabasePath(home) {
  const dataHome = getXdgHome(home, "XDG_DATA_HOME", ".local", "share");
  return process.env.OPENCODE_DB
    ? path.resolve(process.env.OPENCODE_DB)
    : path.join(dataHome, "opencode", "opencode.db");
}

function getHomeRelativePath(home, absolutePath, label) {
  const relativePath = path.relative(home, absolutePath);
  if (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`${label} must be inside HOME so it can be checkpointed.`);
  }
  return relativePath || ".";
}

async function inspectRuntimeState(home, label) {
  const databasePath = getDatabasePath(home);
  let databaseBytes = null;
  let databaseIsSQLite = false;
  try {
    databaseBytes = (await stat(databasePath)).size;
    if (databaseBytes >= 100) {
      const handle = await openFile(databasePath, "r");
      try {
        const header = Buffer.alloc(16);
        const { bytesRead } = await handle.read(header, 0, header.length, 0);
        databaseIsSQLite =
          bytesRead === 16 && header.equals(Buffer.from("SQLite format 3\0"));
      } finally {
        await handle.close();
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  const settingsPath = path.join(getBotHome(home), "settings.json");
  let hasCurrentSession = false;
  let hasCurrentProject = false;
  let settingsExists = false;
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    settingsExists = true;
    hasCurrentSession = Boolean(settings.currentSession);
    hasCurrentProject = Boolean(settings.currentProject);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`Telegram bot settings are unreadable at ${settingsPath}; refusing to claim session continuity.`);
    }
  }

  process.stdout.write(
    `${label}: OpenCode database ${databaseBytes === null ? "MISSING" : `${databaseIsSQLite ? "valid SQLite" : "INVALID"} (${databaseBytes} bytes)`}; ` +
    `bot settings ${settingsExists ? "present" : "not created"}; ` +
    `current session ${hasCurrentSession ? "selected" : "none"}; ` +
    `current project ${hasCurrentProject ? "selected" : "none"}\n`,
  );

  if (hasCurrentSession && !databaseIsSQLite) {
    throw new Error(
      `A Telegram session is selected but the OpenCode database is missing or invalid at ${databasePath}. ` +
      "Checkpoint aborted to avoid losing the session.",
    );
  }
}

async function save() {
  const key = getStateEncryptionKey();
  const root = process.env.GITHUB_WORKSPACE || process.cwd();
  const home = process.env.HOME;
  if (!home) throw new Error("HOME is not set.");

  const botHomeRelative = getHomeRelativePath(home, getBotHome(home), "OPENCODE_TELEGRAM_HOME");
  const configHomeRelative = getHomeRelativePath(
    home,
    getXdgHome(home, "XDG_CONFIG_HOME", ".config"),
    "XDG_CONFIG_HOME",
  );
  const dataHomeRelative = getHomeRelativePath(
    home,
    getXdgHome(home, "XDG_DATA_HOME", ".local", "share"),
    "XDG_DATA_HOME",
  );
  const stateHomeRelative = getHomeRelativePath(
    home,
    getXdgHome(home, "XDG_STATE_HOME", ".local", "state"),
    "XDG_STATE_HOME",
  );

  const candidates = [
    path.join(dataHomeRelative, "opencode"),
    path.join(stateHomeRelative, "opencode", "model.json"),
    path.join(configHomeRelative, "opencode"),
    path.join(botHomeRelative, "settings.json"),
    path.join(botHomeRelative, "settings.json.bak"),
    path.join(botHomeRelative, "local-commands"),
    "projects",
  ];
  const included = [];

  for (const relativePath of candidates) {
    try {
      await stat(path.join(home, relativePath));
      included.push(relativePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  const databasePath = getDatabasePath(home);
  const databaseRelative = getHomeRelativePath(home, databasePath, "OpenCode database");
  const databaseCovered = included.some((entry) =>
    databaseRelative === entry || databaseRelative.startsWith(`${entry}${path.sep}`),
  );
  if (!databaseCovered) {
    try {
      await stat(databasePath);
      included.push(databaseRelative);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }

  if (included.length === 0) {
    throw new Error(
      "No OpenCode, bot, or project state was found to checkpoint.",
    );
  }
  await inspectRuntimeState(home, "Before checkpoint");

  const temp = await mkdtemp(path.join(tmpdir(), "oct-state-"));
  const archivePath = path.join(temp, "state.tar.gz");
  const outputPath = path.join(root, STATE_RELATIVE_PATH);

  try {
    runTar([
      "--create",
      "--gzip",
      "--file",
      archivePath,
      "--directory",
      home,
      `--exclude=${path.join(configHomeRelative, "opencode", "service.json")}`,
      "--exclude=node_modules",
      "--exclude=.venv",
      "--exclude=venv",
      "--exclude=.pytest_cache",
      "--exclude=.mypy_cache",
      "--exclude=.ruff_cache",
      "--exclude=.cache",
      "--exclude=.next",
      "--exclude=.turbo",
      "--exclude=coverage",
      ...included,
    ]);

    const archive = await readFile(archivePath);
    const encrypted = encrypt(archive, key);

    if (encrypted.length > MAX_ENCRYPTED_BYTES) {
      throw new Error(
        `Encrypted checkpoint is ${(encrypted.length / 1024 / 1024).toFixed(1)} MiB; maximum is 95 MiB. ` +
          "Reduce checkpoint size or use a separate encrypted storage service.",
      );
    }

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, encrypted, { mode: 0o600 });
    process.stdout.write(
      `Encrypted checkpoint saved (${(encrypted.length / 1024 / 1024).toFixed(2)} MiB).\n`,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function restore() {
  const key = getStateDecryptionKey();
  const root = process.env.GITHUB_WORKSPACE || process.cwd();
  const home = process.env.HOME;
  if (!home) throw new Error("HOME is not set.");

  const inputPath = path.join(root, STATE_RELATIVE_PATH);
  let encrypted;

  try {
    encrypted = await readFile(inputPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      process.stdout.write(
        "No previous checkpoint found; starting with a clean OpenCode state.\n",
      );
      return;
    }
    throw error;
  }

  const archive = decrypt(encrypted, key);
  const temp = await mkdtemp(path.join(tmpdir(), "oct-restore-"));
  const archivePath = path.join(temp, "state.tar.gz");

  try {
    await writeFile(archivePath, archive, { mode: 0o600 });
    await mkdir(home, { recursive: true });
    runTar([
      "--extract",
      "--gzip",
      "--file",
      archivePath,
      "--directory",
      home,
      "--no-same-owner",
      "--no-same-permissions",
    ]);
    // This file can contain a previous runner's PID/password and is never reusable.
    await rm(
      path.join(getXdgHome(home, "XDG_CONFIG_HOME", ".config"), "opencode", "service.json"),
      { force: true },
    );
    await inspectRuntimeState(home, "After restore");
    process.stdout.write(
      "Previous OpenCode database, sessions, model state, bot settings, and workspaces restored.\n",
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

function selfTest() {
  const token = "123456789:TEST_ONLY_random_secret_for_state_cipher";
  const sample = Buffer.from("OpenCode cloud state encryption self-test\n");
  const encrypted = encrypt(sample, token);
  if (!decrypt(encrypted, token).equals(sample)) {
    throw new Error("Encryption round-trip self-test failed.");
  }

  let rejected = false;
  try {
    decrypt(encrypted, `${token}-wrong`);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("Wrong-key authentication self-test failed.");

  const tampered = Buffer.from(encrypted);
  tampered[tampered.length - 1] ^= 0x01;
  rejected = false;
  try {
    decrypt(tampered, token);
  } catch {
    rejected = true;
  }
  if (!rejected) throw new Error("Tamper-detection self-test failed.");

  process.stdout.write(
    "PASS: AES-256-GCM round-trip, wrong-key rejection, and tamper detection.\n",
  );
}

const command = process.argv[2];

try {
  if (command === "save") await save();
  else if (command === "restore") await restore();
  else if (command === "self-test") selfTest();
  else {
    throw new Error("Usage: node scripts/state.mjs <save|restore|self-test>");
  }
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
