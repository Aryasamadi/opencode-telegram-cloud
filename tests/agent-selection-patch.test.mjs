import assert from "node:assert/strict";
import test from "node:test";
import {
  patchAgentCallbackSource,
  patchV2ClientSource,
} from "../scripts/agent-selection-patch.mjs";

const v2ClientFixture = `const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function applySelection(sessionID, agent, model, variant) {
  if (!agent && !model) return;
  const session = await client.session.get({ sessionID });
  if (agent && session.agent !== agent) {
    await client.session.switchAgent({ sessionID, agent });
  }
}

const adapter = {
  session: {
    get: (params) =>
      run(async () => toV1Session(await client.session.get({ sessionID: params.sessionID }))),
    promptAsync: (params) =>
      run(async () => {
        const admitted = await admitPrompt(params);
        return params.delivery ? { inboxID: admitted.id } : undefined;
      }),
  },
};
`;

const callbackFixture = `import { applyAgentConfiguredSettings, selectAgent } from "../../app/services/agent-selection-service.js";
import { getStoredModel } from "../../app/services/model-selection-service.js";
import { logger } from "../../utils/logger.js";

export async function handleAgentSelect(ctx, deps) {
  try {
    const agentName = callbackQuery.data.replace("agent:", "");
    selectAgent(agentName);
    const settingsApplied = await applyAgentConfiguredSettings(agentName);
    return true;
  } catch (err) {
    logger.error("agent selection failed", err);
    return true;
  }
}
`;

test("V2 client exposes an immediate agent switch and verifies persisted session state", () => {
  const patched = patchV2ClientSource(v2ClientFixture);
  assert.match(patched, /async function switchAgentAndVerify\(sessionID, agent\)/);
  assert.match(patched, /await client\.session\.switchAgent\(\{ sessionID, agent \}\)/);
  assert.match(patched, /updated\.agent === agent/);
  assert.match(patched, /switchAgent: \(params\)/);
  assert.match(patched, /await switchAgentAndVerify\(params\.sessionID, params\.agent\)/);
  assert.match(patched, /await switchAgentAndVerify\(sessionID, agent\)/);
});

test("V2 client patch is idempotent", () => {
  const once = patchV2ClientSource(v2ClientFixture);
  assert.equal(patchV2ClientSource(once), once);
});

test("agent button fails closed unless OpenCode V2 confirms the active session switch", () => {
  const patched = patchAgentCallbackSource(callbackFixture);
  assert.match(patched, /getCurrentSession\(\)/);
  assert.match(patched, /opencodeServerVersion !== "v2"/);
  assert.match(patched, /if \(!activeSession\?\.id\)/);
  assert.match(patched, /await opencodeClient\.session\.switchAgent/);
  assert.match(patched, /if \(switchResult\.error\) throw switchResult\.error/);
  assert.match(patched, /switchResult\.data !== true/);
  assert.match(patched, /confirmedSession\.data\?\.agent !== agentName/);

  const switchAt = patched.indexOf("await opencodeClient.session.switchAgent");
  const verificationAt = patched.indexOf("confirmedSession.data?.agent !== agentName");
  const localSelectionAt = patched.indexOf("selectAgent(agentName);");
  assert.ok(switchAt >= 0 && switchAt < verificationAt);
  assert.ok(verificationAt < localSelectionAt);
});

test("agent callback patch rejects the legacy success-without-session guard", () => {
  const legacy = callbackFixture.replace(
    'const agentName = callbackQuery.data.replace("agent:", "");',
    'const agentName = callbackQuery.data.replace("agent:", "");\n    const activeSession = getCurrentSession();\n    if (activeSession && opencodeServerVersion === "v2") {',
  );
  assert.throws(
    () => patchAgentCallbackSource(legacy),
    /Existing agent callback patch is incomplete/,
  );
});

test("agent callback patch is idempotent", () => {
  const once = patchAgentCallbackSource(callbackFixture);
  assert.equal(patchAgentCallbackSource(once), once);
});

test("patches fail closed when upstream anchors change", () => {
  assert.throws(() => patchV2ClientSource("export const changed = true;"), /applySelection function changed/);
  assert.throws(() => patchAgentCallbackSource("export const changed = true;"), /callback changed/);
});
