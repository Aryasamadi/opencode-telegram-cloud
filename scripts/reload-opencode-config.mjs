export async function reloadOpenCodeConfig(env = process.env) {
  const baseURL = env.OPENCODE_API_URL?.trim();
  const password = env.OPENCODE_SERVER_PASSWORD;
  if (!baseURL) {
    throw new Error("OpenCode server URL is not configured. Provider settings were saved; run /reload when the server is available.");
  }
  if (!password) {
    throw new Error("OpenCode server authentication is unavailable. Provider settings were saved; run /reload when the server is available.");
  }

  let endpoint;
  try {
    endpoint = new URL("/api/location/reload", baseURL);
  } catch {
    throw new Error("OpenCode server URL is invalid. Provider settings were saved; run /reload when the server is available.");
  }

  const username = env.OPENCODE_SERVER_USERNAME || "opencode";
  const authorization = "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: authorization, Accept: "application/json" },
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error("Could not reach OpenCode to reload its configuration. Provider settings were saved; run /reload when the server is available.");
  }

  if (!response.ok) {
    throw new Error(`OpenCode rejected the configuration reload (HTTP ${response.status}). Provider settings were saved; run /reload when the server is available.`);
  }

  return { status: response.status };
}
