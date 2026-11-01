import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANAGER = path.join(ROOT, "scripts", "provider-manager.mjs");

function parseCommand(text) {
  const body = text.replace(/^\/addmodel(?:@\w+)?\s*/i, "");
  const fields = body.split("|").map((part) => part.trim());
  if (fields.length < 4 || fields.length > 5 || fields.some((part, index) => index < 4 && !part)) {
    return null;
  }
  return {
    id: fields[0],
    name: fields[1],
    baseURL: fields[2],
    apiKey: fields[3],
    modelID: fields[4] || "",
  };
}

export async function addModelCommand(ctx) {
  const message = ctx.message;
  const chatId = ctx.chat?.id;
  if (!message?.text || !chatId) return;

  const values = parseCommand(message.text);
  try {
    await ctx.api.deleteMessage(chatId, message.message_id);
  } catch {
    // Continue only for the authorized bot chat; never echo the submitted command.
  }

  if (!values) {
    await ctx.reply(
      "Format:\n/addmodel provider-id | Provider Name | https://api.example.com/v1 | API_KEY | optional-model-id\n\nThe model ID is optional when the provider exposes an OpenAI-compatible /models endpoint. Your submitted command is deleted after receipt.",
    );
    return;
  }

  const args = [
    MANAGER, "add",
    "--id", values.id,
    "--name", values.name,
    "--base-url", values.baseURL,
  ];
  if (values.modelID) args.push("--model-id", values.modelID);

  await ctx.reply("⏳ Checking provider and registering its models…");
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, AI_PROVIDER_API_KEY: values.apiKey },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout = (stdout + chunk).slice(0, 5000); });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-3000); });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 35_000);
    child.once("error", (error) => { clearTimeout(timeout); resolve({ code: -1, stdout: "", stderr: error.message }); });
    child.once("close", (code) => { clearTimeout(timeout); resolve({ code: code ?? -1, stdout, stderr }); });
  });

  if (result.code !== 0) {
    const safeError = (result.stderr || "Provider validation failed.")
      .replaceAll(values.apiKey, "[redacted]")
      .replaceAll(values.baseURL, "[provider endpoint]")
      .slice(-1800);
    await ctx.reply(`❌ Provider was not registered.\n${safeError}`);
    return;
  }

  const safeOutput = (result.stdout || "Provider registered.")
    .replaceAll(values.apiKey, "[redacted]")
    .replaceAll(values.baseURL, "[provider endpoint]")
    .slice(0, 1800);
  await ctx.reply(`✅ ${safeOutput}\n\nNow run /reload, then open /models → Providers.`);
}
