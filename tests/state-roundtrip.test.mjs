import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = path.resolve("scripts/state.mjs");
const token = "123456789:TEST_ONLY_session_checkpoint_roundtrip";

test("encrypted checkpoint restores OpenCode DB, bot session selection, model state, and workspace", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-state-roundtrip-"));
  const workspace = path.join(root, "repository");
  const sourceHome = path.join(root, "source-home");
  const restoredHome = sourceHome;
  const dbPath = path.join(sourceHome, ".local/share/opencode/opencode.db");
  const settingsPath = path.join(sourceHome, ".config/opencode-telegram-bot/settings.json");
  const modelPath = path.join(sourceHome, ".local/state/opencode/model.json");
  const staleServicePath = path.join(sourceHome, ".config/opencode/service.json");
  const projectFile = path.join(sourceHome, "projects/demo/main.py");
  const settingsFixture = {
    currentProject: { directory: path.join(sourceHome, "projects/demo") },
    currentSession: { id: "ses_persistent_test", title: "Persistent session" },
  };
  const modelFixture = { providerID: "test-provider", modelID: "test-model" };

  try {
    await Promise.all([
      mkdir(path.dirname(dbPath), { recursive: true }),
      mkdir(path.dirname(settingsPath), { recursive: true }),
      mkdir(path.dirname(modelPath), { recursive: true }),
      mkdir(path.dirname(staleServicePath), { recursive: true }),
      mkdir(path.dirname(projectFile), { recursive: true }),
      mkdir(path.join(workspace, ".state"), { recursive: true }),
    ]);
    const createDatabase = spawnSync("python3", ["-c", [
      "import sqlite3, sys",
      "db = sqlite3.connect(sys.argv[1])",
      "db.execute('CREATE TABLE session (id TEXT PRIMARY KEY, title TEXT NOT NULL)')",
      "db.execute('INSERT INTO session (id, title) VALUES (?, ?)', ('ses_persistent_test', 'Persistent session'))",
      "db.commit()",
      "db.close()",
    ].join("\n"), dbPath], { encoding: "utf8" });
    assert.equal(createDatabase.status, 0, createDatabase.stderr);

    await Promise.all([
      writeFile(settingsPath, JSON.stringify(settingsFixture)),
      writeFile(modelPath, JSON.stringify(modelFixture)),
      writeFile(staleServicePath, JSON.stringify({ password: "old-runner-secret", pid: 1234 })),
      writeFile(projectFile, "print('checkpointed workspace')\n"),
    ]);

    const baseEnv = {
      ...process.env,
      STATE_ENCRYPTION_KEY: token,
      STATE_DECRYPTION_KEY: token,
      GITHUB_WORKSPACE: workspace,
      XDG_DATA_HOME: path.join(sourceHome, ".local/share"),
      XDG_CONFIG_HOME: path.join(sourceHome, ".config"),
      XDG_STATE_HOME: path.join(sourceHome, ".local/state"),
      OPENCODE_TELEGRAM_HOME: path.join(sourceHome, ".config/opencode-telegram-bot"),
    };
    const save = spawnSync(process.execPath, [script, "save"], {
      env: { ...baseEnv, HOME: sourceHome },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(save.status, 0, save.stderr || save.stdout);

    const encryptedCheckpoint = await readFile(path.join(workspace, ".state/agent-state.v1.enc"));
    assert.ok(encryptedCheckpoint.length > 0);
    assert.equal(encryptedCheckpoint.includes(Buffer.from("SQLite format 3")), false);
    assert.equal(encryptedCheckpoint.includes(Buffer.from(token)), false);

    // Simulate a fresh GitHub runner with the same stable HOME path.
    await rm(sourceHome, { recursive: true, force: true });
    await mkdir(sourceHome, { recursive: true });

    const restore = spawnSync(process.execPath, [script, "restore"], {
      env: { ...baseEnv, HOME: restoredHome, OPENCODE_TELEGRAM_HOME: path.join(restoredHome, ".config/opencode-telegram-bot") },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(restore.status, 0, restore.stderr || restore.stdout);

    const restoredDatabasePath = path.join(restoredHome, ".local/share/opencode/opencode.db");
    const verifyDatabase = spawnSync("python3", ["-c",
      "import sqlite3, sys; db=sqlite3.connect(sys.argv[1]); assert db.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'; row=db.execute('SELECT id, title FROM session').fetchone(); assert row == ('ses_persistent_test', 'Persistent session'), row; print('|'.join(row)); db.close()",
      restoredDatabasePath], { encoding: "utf8" });
    assert.equal(verifyDatabase.status, 0, verifyDatabase.stderr || verifyDatabase.stdout);
    assert.equal(verifyDatabase.stdout.trim(), "ses_persistent_test|Persistent session");
    assert.deepEqual(
      JSON.parse(await readFile(path.join(restoredHome, ".config/opencode-telegram-bot/settings.json"), "utf8")),
      settingsFixture,
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(restoredHome, ".local/state/opencode/model.json"), "utf8")),
      modelFixture,
    );
    await assert.rejects(readFile(path.join(restoredHome, ".config/opencode/service.json")), { code: "ENOENT" });
    assert.equal(
      await readFile(path.join(restoredHome, "projects/demo/main.py"), "utf8"),
      "print('checkpointed workspace')\n",
    );
    assert.match(restore.stdout, /current session selected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
