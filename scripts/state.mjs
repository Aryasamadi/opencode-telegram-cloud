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
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { gunzipSync, gzipSync } from "node:zlib";
import path from "node:path";

const MAGIC = Buffer.from("OCTSTATE");
const VERSION = 1;
const HEADER_LENGTH = 8 + 1 + 16 + 12;
const TAG_LENGTH = 16;
const MAX_ENCRYPTED_BYTES = 95 * 1024 * 1024;
const STATE_RELATIVE_PATH = ".state/agent-state.v1.enc";
const PREVIOUS_STATE_RELATIVE_PATH = ".state/agent-state.previous.enc";
const MANIFEST_NAME = "checkpoint-manifest.json";

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

function deriveKey(secret, salt) {
  // Telegram bot tokens are high-entropy credentials. Scrypt derives a separate
  // 256-bit state key; the random salt is stored with each encrypted snapshot.
  return scryptSync(`opencode-telegram-cloud-state-v1:${secret}`, salt, 32, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

function encrypt(plain, key) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = Buffer.concat([MAGIC, Buffer.from([VERSION]), salt, iv]);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(key, salt), iv);
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
    deriveKey(key, salt),
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

async function validateArchive(archivePath) {
  const entries = execFileSync("tar", ["--list", "--file", archivePath], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).split("\n").filter(Boolean);
  for (const entry of entries) {
    const normalized = path.posix.normalize(entry);
    if (path.posix.isAbsolute(entry) || normalized === ".." || normalized.startsWith("../")) {
      throw new Error(`Checkpoint archive contains an unsafe path: ${entry}`);
    }
  }
  if (!entries.includes(MANIFEST_NAME)) {
    // Phase 1 checkpoints predate manifests; accept them as legacy recovery points.
    return { formatVersion: 0, createdAt: "legacy checkpoint", currentSession: null, selectedProjectRelative: "unknown", includedPaths: [] };
  }
  const manifestText = execFileSync("tar", ["--extract", "--to-stdout", "--file", archivePath, MANIFEST_NAME], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const manifest = JSON.parse(manifestText);
  if (manifest?.formatVersion !== 1 || typeof manifest.createdAt !== "string" ||
      !Array.isArray(manifest.includedPaths) || typeof manifest.selectedProjectRelative !== "string" ||
      (manifest.databaseRelative !== null && typeof manifest.databaseRelative !== "string")) {
    throw new Error("Checkpoint recovery manifest is invalid or unsupported.");
  }
  if (manifest.databaseRelative) {
    const databaseRelative = path.posix.normalize(manifest.databaseRelative);
    if (path.posix.isAbsolute(databaseRelative) || databaseRelative === ".." || databaseRelative.startsWith("../")) {
      throw new Error("Checkpoint manifest contains an unsafe database path.");
    }
    const temp = await mkdtemp(path.join(tmpdir(), "oct-validate-db-"));
    try {
      execFileSync("tar", ["--extract", "--file", archivePath, "--directory", temp, "--no-same-owner", "--no-same-permissions", manifest.databaseRelative], { stdio: "ignore" });
      const databasePath = path.join(temp, manifest.databaseRelative);
      const integrity = execFileSync("sqlite3", [databasePath, "PRAGMA integrity_check;"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
      if (integrity !== "ok") throw new Error(`Checkpoint SQLite integrity_check failed: ${integrity || "no result"}`);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  } else if (manifest.currentSession) {
    throw new Error("Checkpoint manifest selects a session but has no database path.");
  }
  return manifest;
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

function isPathCovered(relativePath, includedPaths) {
  return includedPaths.some((entry) =>
    relativePath === entry || relativePath.startsWith(`${entry}${path.sep}`),
  );
}

async function getSelectedProjectWorktree(home) {
  const settingsPath = path.join(getBotHome(home), "settings.json");
  let settings;
  try {
    settings = JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Cannot read Telegram bot settings at ${settingsPath} to locate the selected project.`);
  }

  const worktree = settings.currentProject?.worktree;
  if (worktree === undefined || worktree === null || worktree === "") return null;
  if (typeof worktree !== "string") {
    throw new Error("Selected project worktree is not a valid path; refusing to checkpoint incomplete project state.");
  }

  const absolutePath = path.resolve(worktree);
  const relativePath = getHomeRelativePath(home, absolutePath, "Selected project worktree");
  // HOME itself is a valid selected project in the Telegram bot. In that case,
  // save() archives the HOME tree with explicit exclusions for credentials,
  // runner internals, caches, and the live checkout.
  if (relativePath === ".") return ".";

  try {
    const projectStat = await stat(absolutePath);
    if (!projectStat.isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error(`Selected project directory is missing or unreadable: ${absolutePath}. Checkpoint aborted.`);
  }

  return relativePath;
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
  let projectWorktreeExists = false;
  let settingsExists = false;
  try {
    const settings = JSON.parse(await readFile(settingsPath, "utf8"));
    settingsExists = true;
    hasCurrentSession = Boolean(settings.currentSession);
    hasCurrentProject = Boolean(settings.currentProject);
    const worktree = settings.currentProject?.worktree;
    if (worktree) {
      const absoluteWorktree = path.resolve(worktree);
      getHomeRelativePath(home, absoluteWorktree, "Selected project worktree");
      const worktreeStat = await stat(absoluteWorktree);
      projectWorktreeExists = worktreeStat.isDirectory();
      if (!projectWorktreeExists) {
        throw new Error(`Selected project path is not a directory: ${absoluteWorktree}`);
      }
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`Telegram bot settings are unreadable at ${settingsPath}; refusing to claim session continuity.`);
    }
  }

  if (databaseBytes !== null) {
    if (!databaseIsSQLite) {
      throw new Error(
        `OpenCode database exists but is not a valid SQLite file at ${databasePath}. ` +
        "Checkpoint/restore aborted rather than preserving a corrupt database.",
      );
    }
    let integrity;
    try {
      integrity = execFileSync("sqlite3", [databasePath, "PRAGMA integrity_check;"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (error) {
      throw new Error(
        `SQLite integrity_check could not run for ${databasePath}; refusing to claim continuity. ${error.message}`,
      );
    }
    if (integrity !== "ok") {
      throw new Error(
        `SQLite integrity_check failed for ${databasePath}: ${integrity || "no result"}`,
      );
    }
  }

  process.stdout.write(
    `${label}: OpenCode database ${databaseBytes === null ? "MISSING" : `valid SQLite + integrity_check=ok (${databaseBytes} bytes)`}; ` +
    `bot settings ${settingsExists ? "present" : "not created"}; ` +
    `current session ${hasCurrentSession ? "selected" : "none"}; ` +
    `current project ${hasCurrentProject ? (projectWorktreeExists ? "selected; worktree present" : "selected; worktree missing") : "none"}\n`,
  );

  if (hasCurrentSession && databaseBytes === null) {
    throw new Error(
      `A Telegram session is selected but the OpenCode database is missing at ${databasePath}. ` +
      "Checkpoint/restore aborted to avoid losing the session.",
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

  const selectedProjectRelative = await getSelectedProjectWorktree(home);
  if (selectedProjectRelative === ".") {
    // The user explicitly selected HOME as the project root. Archive it once,
    // excluding runner internals and the controller checkout below.
    included.splice(0, included.length, ".");
  } else if (selectedProjectRelative && !isPathCovered(selectedProjectRelative, included)) {
    // Archive the selected path explicitly, even when it is under /home/runner/work.
    included.push(selectedProjectRelative);
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
  const archivePath = path.join(temp, "state.tar");
  const databaseSnapshotPath = path.join(temp, "opencode.db.snapshot");
  const manifestPath = path.join(temp, MANIFEST_NAME);
  const outputPath = path.join(root, STATE_RELATIVE_PATH);

  try {
    const tarExcludes = [
      `--exclude=${path.join(configHomeRelative, "opencode", "service.json")}`,
      ...(selectedProjectRelative === "." ? ["--exclude=work"] : []),
      // Never copy host credentials or ephemeral GitHub-hosted runner internals.
      "--exclude=.ssh",
      "--exclude=.gnupg",
      "--exclude=.aws",
      "--exclude=.azure",
      "--exclude=.docker",
      "--exclude=.kube",
      "--exclude=.npm",
      "--exclude=.config/gh",
      "--exclude=.git-credentials",
      "--exclude=.netrc",
      "--exclude=.npmrc",
      "--exclude=.bash_history",
      // Do not globally exclude HOME/work: a selected project may live there.
      // HOME itself is handled separately to avoid restoring an old controller checkout.
      "--exclude=_work",
      "--exclude=_temp",
      "--exclude=externals",
      "--exclude=_diag",
      "--exclude=actions-runner",
      "--exclude=node_modules",
      "--exclude=.git",
      "--exclude=.state",
      "--exclude=.venv",
      "--exclude=venv",
      "--exclude=.pytest_cache",
      "--exclude=.mypy_cache",
      "--exclude=.ruff_cache",
      "--exclude=.cache",
      "--exclude=.next",
      "--exclude=.turbo",
      "--exclude=coverage",
    ];
    const databaseExists = await stat(databasePath).then(() => true).catch((error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
    if (databaseExists) {
      for (const suffix of ["", "-wal", "-shm"]) {
        tarExcludes.push(`--exclude=${databaseRelative + suffix}`);
      }
    }
    runTar([
      "--create", "--file", archivePath, "--directory", home,
      ...tarExcludes, `--exclude=${MANIFEST_NAME}`, ...included,
    ]);

    if (databaseExists) {
      try {
        execFileSync("sqlite3", [databasePath, `.backup '${databaseSnapshotPath}'`], { stdio: "inherit" });
        const sourceTimes = await Promise.all(["", "-wal"].map(async (suffix) => {
          try { return (await stat(databasePath + suffix)).mtimeMs; }
          catch (error) { if (error?.code === "ENOENT") return 0; throw error; }
        }));
        const snapshotTime = new Date(Math.max(...sourceTimes));
        await utimes(databaseSnapshotPath, snapshotTime, snapshotTime);
      } catch (error) {
        throw new Error("SQLite online backup failed; refusing to checkpoint a potentially inconsistent live database. Ensure sqlite3 is installed. " + error.message);
      }
      runTar([
        "--append", "--file", archivePath, "--directory", temp,
        `--transform=s|^opencode.db.snapshot${databaseRelative.startsWith("/") ? "" : ""}|${databaseRelative}|`,
        "opencode.db.snapshot",
      ]);
    }

    const settings = await readFile(path.join(getBotHome(home), "settings.json"), "utf8").then(JSON.parse).catch(() => ({}));
    const manifest = {
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      openCodeVersion: process.env.OPENCODE_VERSION || null,
      currentSession: settings.currentSession || null,
      selectedProjectRelative,
      includedPaths: included,
      databaseRelative: databaseExists ? databaseRelative : null,
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
    runTar(["--append", "--file", archivePath, "--directory", temp, MANIFEST_NAME]);
    const plainArchive = await readFile(archivePath);
    let previousEncrypted = null;
    try {
      previousEncrypted = await readFile(outputPath);
      const previousArchive = gunzipSync(decrypt(previousEncrypted, key));
      const previousArchivePath = path.join(temp, "previous-checkpoint.tar.gz");
      await writeFile(previousArchivePath, previousArchive, { mode: 0o600 });
      await validateArchive(previousArchivePath);
      if (previousArchive.equals(plainArchive)) {
        process.stdout.write("Checkpoint content is unchanged; preserving the existing encrypted snapshot.\\n");
        return;
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error("Existing checkpoint could not be authenticated and validated; refusing to replace it. " + error.message);
      }
    }

    const archive = gzipSync(plainArchive);
    const encrypted = encrypt(archive, key);

    if (encrypted.length > MAX_ENCRYPTED_BYTES) {
      throw new Error(
        `Encrypted checkpoint is ${(encrypted.length / 1024 / 1024).toFixed(1)} MiB; maximum is 95 MiB. ` +
          "Reduce checkpoint size or use a separate encrypted storage service.",
      );
    }

    await mkdir(path.dirname(outputPath), { recursive: true });
    if (previousEncrypted) {
      const previousPath = path.join(root, PREVIOUS_STATE_RELATIVE_PATH);
      const temporaryPreviousPath = `${previousPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
      try {
        await writeFile(temporaryPreviousPath, previousEncrypted, { mode: 0o600, flag: "wx" });
        await rename(temporaryPreviousPath, previousPath);
      } finally {
        await rm(temporaryPreviousPath, { force: true });
      }
    }
    const temporaryOutputPath = `${outputPath}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    try {
      await writeFile(temporaryOutputPath, encrypted, { mode: 0o600, flag: "wx" });
      await rename(temporaryOutputPath, outputPath);
    } finally {
      await rm(temporaryOutputPath, { force: true });
    }
    process.stdout.write(
      `Encrypted checkpoint saved atomically (${(encrypted.length / 1024 / 1024).toFixed(2)} MiB).\n`,
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

  const candidates = [
    { label: "current", path: path.join(root, STATE_RELATIVE_PATH) },
    { label: "previous known-good", path: path.join(root, PREVIOUS_STATE_RELATIVE_PATH) },
  ];
  const temp = await mkdtemp(path.join(tmpdir(), "oct-restore-"));
  const archivePath = path.join(temp, "state.tar.gz");
  let selectedCandidate = null;
  let manifest = null;

  try {
    for (const candidate of candidates) {
      try {
        const encrypted = await readFile(candidate.path);
        const archive = gunzipSync(decrypt(encrypted, key));
        await writeFile(archivePath, archive, { mode: 0o600 });
        manifest = await validateArchive(archivePath);
        selectedCandidate = candidate;
        break;
      } catch (error) {
        if (error?.code === "ENOENT") continue;
        process.stderr.write(`Checkpoint candidate ${candidate.label} rejected: ${error.message}\n`);
      }
    }

    if (!selectedCandidate) {
      const hasAnyCheckpoint = await Promise.all(candidates.map(({ path: candidatePath }) =>
        readFile(candidatePath).then(() => true).catch((error) => {
          if (error?.code === "ENOENT") return false;
          throw error;
        }),
      )).then((values) => values.some(Boolean));
      if (!hasAnyCheckpoint && process.env.STATE_ALLOW_EMPTY_CHECKPOINT === "true") {
        process.stdout.write("No previous checkpoint found; explicit STATE_ALLOW_EMPTY_CHECKPOINT=true allows first-time bootstrap.\n");
        return;
      }
      if (!hasAnyCheckpoint) {
        throw new Error(
          "No previous checkpoint found. Refusing to start with an empty state because this may hide data loss. " +
          "For a deliberate first-ever setup only, set the GitHub Actions variable STATE_ALLOW_EMPTY_CHECKPOINT=true, " +
          "run once, confirm a checkpoint was committed, then remove that variable.",
        );
      }
      throw new Error("Both the current and previous encrypted checkpoints are missing or invalid; refusing to start with empty state.");
    }

    process.stdout.write(`Restoring ${selectedCandidate.label} checkpoint created at ${manifest.createdAt}; session=${manifest.currentSession || "none"}; project=${manifest.selectedProjectRelative}.\n`);
    await mkdir(home, { recursive: true });
    runTar(["--extract", "--file", archivePath, "--directory", home, "--no-same-owner", "--no-same-permissions"]);
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
