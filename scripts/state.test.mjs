#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./state.mjs", import.meta.url));
const root = await mkdtemp(path.join(os.tmpdir(), "oct-state-roundtrip-"));
const home = path.join(root, "runner-home");
const workspace = path.join(root, "workspace");
const key = "roundtrip-test-key-do-not-use-in-production-2026";
const env = {
  ...process.env,
  HOME: home,
  GITHUB_WORKSPACE: workspace,
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_DATA_HOME: path.join(home, ".local", "share"),
  XDG_STATE_HOME: path.join(home, ".local", "state"),
  OPENCODE_TELEGRAM_HOME: path.join(home, ".config", "opencode-telegram-bot"),
  STATE_ENCRYPTION_KEY: key,
  STATE_DECRYPTION_KEY: key,
};

function run(command) {
  execFileSync(process.execPath, [script, command], { env, stdio: "inherit" });
}

try {
  const botHome = env.OPENCODE_TELEGRAM_HOME;
  const project = path.join(home, "work", "opencode-telegram-cloud", "opencode-telegram-cloud");
  const database = path.join(home, ".local", "share", "opencode", "opencode.db");
  await Promise.all([
    mkdir(botHome, { recursive: true }),
    mkdir(path.dirname(database), { recursive: true }),
    mkdir(project, { recursive: true }),
    mkdir(path.join(home, ".local", "state", "opencode"), { recursive: true }),
    mkdir(path.join(home, ".config", "opencode"), { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);

  await writeFile(path.join(botHome, "settings.json"), JSON.stringify({
    currentSession: "ses_roundtrip_test",
    currentProject: { worktree: project },
    providers: { roundtrip: { name: "Round-trip test provider" } },
  }, null, 2));
  await writeFile(path.join(project, "important-work.txt"), "project checkpoint survived\n");
  await writeFile(path.join(home, ".local", "state", "opencode", "model.json"), JSON.stringify({
    providerID: "roundtrip",
    modelID: "test-model",
  }));
  await writeFile(path.join(home, ".config", "opencode", "opencode.json"), JSON.stringify({
    provider: { roundtrip: { npm: "@ai-sdk/openai-compatible" } },
  }));

  execFileSync("sqlite3", [database, "CREATE TABLE continuity_test (value TEXT); INSERT INTO continuity_test VALUES ('session-history-preserved');"], { env });
  run("self-test");

  // Missing checkpoints must fail closed unless first-run bootstrap is explicit.
  const missingRestore = spawnSync(process.execPath, [script, "restore"], { env, encoding: "utf8" });
  assert.notEqual(missingRestore.status, 0, "missing checkpoint must not silently start clean");
  assert.match(missingRestore.stderr, /No previous checkpoint found/);
  env.STATE_ALLOW_EMPTY_CHECKPOINT = "true";
  run("restore");
  delete env.STATE_ALLOW_EMPTY_CHECKPOINT;

  run("save");

  const checkpoint = path.join(workspace, ".state", "agent-state.v1.enc");
  const checkpointBytes = await readFile(checkpoint);
  assert.ok(checkpointBytes.length > 64, "encrypted checkpoint should be non-empty");

  // Save a second generation, verify rotation, then corrupt the latest ciphertext.
  await writeFile(path.join(project, "important-work.txt"), "newer work that should roll back\n");
  run("save");
  const previousCheckpoint = path.join(workspace, ".state", "agent-state.previous.enc");
  const previousBytes = await readFile(previousCheckpoint);
  assert.ok(previousBytes.length > 64, "previous known-good checkpoint should be retained");
  const damagedLatest = await readFile(checkpoint);
  damagedLatest[damagedLatest.length - 1] ^= 0x01;
  await writeFile(checkpoint, damagedLatest);

  // Simulate a fresh hosted runner; restore must fall back to the previous generation.
  await rm(home, { recursive: true, force: true });
  run("restore");

  const restoredSettings = JSON.parse(await readFile(path.join(botHome, "settings.json"), "utf8"));
  assert.equal(restoredSettings.currentSession, "ses_roundtrip_test");
  assert.equal(restoredSettings.currentProject.worktree, project);
  assert.equal(restoredSettings.providers.roundtrip.name, "Round-trip test provider");
  assert.equal(await readFile(path.join(project, "important-work.txt"), "utf8"), "project checkpoint survived\n");

  const restoredModel = JSON.parse(await readFile(path.join(home, ".local", "state", "opencode", "model.json"), "utf8"));
  assert.equal(restoredModel.modelID, "test-model");
  const restoredProvider = JSON.parse(await readFile(path.join(home, ".config", "opencode", "opencode.json"), "utf8"));
  assert.ok(restoredProvider.provider.roundtrip);

  const databaseValue = execFileSync("sqlite3", [database, "SELECT value FROM continuity_test;"], { encoding: "utf8" }).trim();
  assert.equal(databaseValue, "session-history-preserved");

  process.stdout.write("PASS: encrypted checkpoint round-trip preserved SQLite session data, bot settings, model/provider config, and selected project files.\n");
} finally {
  await rm(root, { recursive: true, force: true });
}
