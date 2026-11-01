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
  const restoredHome = path.join(root, "restored-home");
  const dbPath = path.join(sourceHome, ".local/share/opencode/opencode.db");
  const settingsPath = path.join(sourceHome, ".config/opencode-telegram-bot/settings.json");
  const modelPath = path.join(sourceHome, ".local/state/opencode/model.json");
  const projectFile = path.join(sourceHome, "projects/demo/main.py");
  const databaseFixture = Buffer.concat([
    Buffer.from("SQLite format 3\0"),
    Buffer.from("test session database payload"),
  ]);
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
      mkdir(path.dirname(projectFile), { recursive: true }),
      mkdir(path.join(workspace, ".state"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(dbPath, databaseFixture),
      writeFile(settingsPath, JSON.stringify(settingsFixture)),
      writeFile(modelPath, JSON.stringify(modelFixture)),
      writeFile(projectFile, "print('checkpointed workspace')\n"),
    ]);

    const baseEnv = {
      ...process.env,
      TELEGRAM_BOT_TOKEN: token,
      GITHUB_WORKSPACE: workspace,
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

    const restore = spawnSync(process.execPath, [script, "restore"], {
      env: { ...baseEnv, HOME: restoredHome, OPENCODE_TELEGRAM_HOME: path.join(restoredHome, ".config/opencode-telegram-bot") },
      encoding: "utf8",
      timeout: 60_000,
    });
    assert.equal(restore.status, 0, restore.stderr || restore.stdout);

    assert.deepEqual(await readFile(path.join(restoredHome, ".local/share/opencode/opencode.db")), databaseFixture);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(restoredHome, ".config/opencode-telegram-bot/settings.json"), "utf8")),
      settingsFixture,
    );
    assert.deepEqual(
      JSON.parse(await readFile(path.join(restoredHome, ".local/state/opencode/model.json"), "utf8")),
      modelFixture,
    );
    assert.equal(
      await readFile(path.join(restoredHome, "projects/demo/main.py"), "utf8"),
      "print('checkpointed workspace')\n",
    );
    assert.match(restore.stdout, /current session selected/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
