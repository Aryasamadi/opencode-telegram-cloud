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
    "OpenCode did not apply agent " + agent + " to session " + sessionID +
      "; session reports " + (actual ?? "unset") + ".",
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
    source.includes('if (opencodeServerVersion !== "v2") {') &&
    source.includes("if (!activeSession?.id) {") &&
    source.includes("if (switchResult.data !== true) {") &&
    source.includes("confirmedSession.data?.agent !== agentName");

  if (alreadyPatched) return source;

  // A previous revision could announce success when no active session existed.
  // Never silently preserve that partially patched callback.
  if (
    source.includes("const activeSession = getCurrentSession();") ||
    source.includes("await opencodeClient.session.switchAgent")
  ) {
    throw new Error(
      "Existing agent callback patch is incomplete; refusing to keep a success-without-session path.",
    );
  }

  const importPattern =
    /import\s*\{\s*applyAgentConfiguredSettings\s*,\s*selectAgent\s*,?\s*\}\s*from\s*["\']\.\.\/\.\.\/app\/services\/agent-selection-service\.js["\'];/;
  const agentNameAnchor =
    'const agentName = callbackQuery.data.replace("agent:", "");';

  if (!importPattern.test(source) || !source.includes(agentNameAnchor)) {
    throw new Error("Upstream agent-selection callback changed; refusing to patch.");
  }

  const imports =
    "\n" + "im" + "port { opencodeClient, opencodeServerVersion } from \"../../opencode/client.js\";" +
    "\n" + "im" + "port { getCurrentSession } from \"../../app/services/session-service.js\";";

  const switchBlock = `
    // Fail closed: a local button selection is not a session-level agent switch.
    if (opencodeServerVersion !== "v2") {
      throw new Error("Cannot switch OpenCode agent: bot is not configured for V2.");
    }

    const activeSession = getCurrentSession();
    if (!activeSession?.id) {
      throw new Error("Cannot switch OpenCode agent: no active session is selected.");
    }

    const switchResult = await opencodeClient.session.switchAgent({
      sessionID: activeSession.id,
      agent: agentName,
    });
    if (switchResult.error) throw switchResult.error;
    if (switchResult.data !== true) {
      throw new Error(
        "OpenCode did not confirm switching session " + activeSession.id +
          ' to agent "' + agentName + '".',
      );
    }

    // Independently read the session back before changing the bot's stored choice
    // or sending the Telegram success message.
    const confirmedSession = await opencodeClient.session.get({
      sessionID: activeSession.id,
    });
    if (confirmedSession.error) throw confirmedSession.error;
    if (confirmedSession.data?.agent !== agentName) {
      throw new Error(
        "OpenCode session " + activeSession.id + " still reports agent " +
          (confirmedSession.data?.agent ?? "unset") + " after requesting " + agentName + ".",
      );
    }

    logger.info(
      "[AgentHandler] OpenCode session " + activeSession.id +
        ' confirmed agent "' + agentName + '"',
    );
`;

  let updated = source.replace(importPattern, (match) => match + imports);
  updated = updated.replace(agentNameAnchor, agentNameAnchor + switchBlock);

  if (
    !updated.includes('if (opencodeServerVersion !== "v2") {') ||
    !updated.includes("if (!activeSession?.id) {") ||
    !updated.includes("if (switchResult.data !== true) {") ||
    !updated.includes("confirmedSession.data?.agent !== agentName") ||
    updated.indexOf("await opencodeClient.session.switchAgent") >
      updated.indexOf("selectAgent(agentName);") ||
    updated.indexOf("confirmedSession.data?.agent !== agentName") >
      updated.indexOf("selectAgent(agentName);")
  ) {
    throw new Error("Could not install fail-closed, session-verified agent selection.");
  }

  return updated;
}
