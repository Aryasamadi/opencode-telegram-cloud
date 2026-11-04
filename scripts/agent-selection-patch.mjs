/**
 * Runtime source transforms for the published @grinev/opencode-telegram-bot package.
 * Keep these anchors narrow and fail closed when the upstream distribution changes.
 */
export function patchV2ClientSource(source) {
  const alreadyPatched =
    source.includes("async function switchAgentAndVerify(") &&
    source.includes("switchAgent: (params)") &&
    source.includes("await switchAgentAndVerify(sessionID, agent);") &&
    source.includes("await switchAgentAndVerify(params.sessionID, params.agent);");

  if (alreadyPatched) return source;
  if (source.includes("async function switchAgentAndVerify(")) {
    throw new Error("V2 client contains a partial agent-switch patch; refusing to modify it.");
  }

  const applyAnchor = "async function applySelection(";
  if (!source.includes(applyAnchor)) {
    throw new Error("Upstream V2 applySelection function changed; refusing to patch.");
  }

  const originalSwitch = /if \(agent && session\.agent !== agent\) \{\s*await client\.session\.switchAgent\(\{ sessionID, agent \}\);\s*\}/;
  if (!originalSwitch.test(source)) {
    throw new Error("Upstream V2 agent-switch call changed; refusing to patch.");
  }

  const getMethod = /(^[ \t]*)get: \(params\) =>\s*run\(async \(\) => toV1Session\(await client\.session\.get\(\{ sessionID: params\.sessionID \}\)\)\),/m;
  const getMatch = source.match(getMethod);
  if (!getMatch) {
    throw new Error("Upstream V2 session.get adapter changed; refusing to expose verified agent switching.");
  }

  const helper = `async function switchAgentAndVerify(sessionID, agent) {
  const current = await client.session.get({ sessionID });
  if (current.agent === agent) return;

  await client.session.switchAgent({ sessionID, agent });

  // The API acknowledges the event write; verify the projected session before
  // reporting success or admitting the next prompt.
  for (let attempt = 0; attempt < 10; attempt++) {
    const updated = await client.session.get({ sessionID });
    if (updated.agent === agent) return;
    if (attempt < 9) await delay(50);
  }

  const actual = (await client.session.get({ sessionID })).agent;
  throw new Error(
    "OpenCode did not apply agent \"" + agent + "\" to session " + sessionID +
      "; session reports \"" + (actual ?? "unset") + "\".",
  );
}

`;

  let updated = source.replace(applyAnchor, helper + applyAnchor);
  updated = updated.replace(
    originalSwitch,
    "if (agent && session.agent !== agent) {\n      await switchAgentAndVerify(sessionID, agent);\n    }",
  );

  const wrapper = `
      switchAgent: (params) =>
        run(async () => {
          await switchAgentAndVerify(params.sessionID, params.agent);
          return true;
        }),`;
  updated = updated.replace(getMethod, (match) => match + wrapper);

  if (
    !updated.includes("await switchAgentAndVerify(sessionID, agent);") ||
    !updated.includes("switchAgent: (params)") ||
    !updated.includes("await switchAgentAndVerify(params.sessionID, params.agent);")
  ) {
    throw new Error("Could not install all verified agent-switch paths.");
  }

  return updated;
}

export function patchAgentCallbackSource(source) {
  const alreadyPatched =
    source.includes("await opencodeClient.session.switchAgent") &&
    source.includes("opencodeServerVersion === \"v2\"") &&
    source.includes("getCurrentSession");

  if (alreadyPatched) return source;

  const importAnchor =
    'import { applyAgentConfiguredSettings, selectAgent } from "../../app/services/agent-selection-service.js";';
  const agentNameAnchor =
    'const agentName = callbackQuery.data.replace("agent:", "");';

  if (!source.includes(importAnchor) || !source.includes(agentNameAnchor)) {
    throw new Error("Upstream agent-selection callback changed; refusing to patch.");
  }

  const imports = `
import { opencodeClient, opencodeServerVersion } from "../../opencode/client.js";
import { getCurrentSession } from "../../app/services/session-service.js";`;

  const switchBlock = `
    // Apply the selection to the active OpenCode V2 session immediately.
    // Do not persist or announce the new selection if OpenCode refuses it.
    const activeSession = getCurrentSession();
    if (activeSession && opencodeServerVersion === "v2") {
      const switchResult = await opencodeClient.session.switchAgent({
        sessionID: activeSession.id,
        agent: agentName,
      });
      if (switchResult.error) throw switchResult.error;
      logger.info(
        `[AgentHandler] OpenCode session ${activeSession.id} confirmed agent "${agentName}"`,
      );
    }
`;

  let updated = source.replace(importAnchor, importAnchor + imports);
  updated = updated.replace(agentNameAnchor, agentNameAnchor + switchBlock);

  if (
    !updated.includes("await opencodeClient.session.switchAgent") ||
    !updated.includes("if (switchResult.error) throw switchResult.error;") ||
    updated.indexOf("await opencodeClient.session.switchAgent") > updated.indexOf("selectAgent(agentName);")
  ) {
    throw new Error("Could not install immediate, verified agent selection.");
  }

  return updated;
}
