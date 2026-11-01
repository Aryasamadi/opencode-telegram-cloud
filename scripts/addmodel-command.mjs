import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANAGER = path.join(ROOT, "scripts", "provider-manager.mjs");

function deriveProviderId(name) {
  const slug = name.normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return slug || `provider-${createHash("sha256").update(name).digest("hex").slice(0, 10)}`;
}

function parseQuotedFields(body) {
  const fields = [];
  let index = 0;

  while (index < body.length) {
    while (/\s/.test(body[index] ?? "")) index += 1;
    if (index >= body.length) break;
    if (body[index] !== '"') return null;

    index += 1;
    let value = "";
    let closed = false;
    while (index < body.length) {
      const character = body[index];
      if (character === "\\") {
        const next = body[index + 1];
        if (next === '"' || next === "\\") {
          value += next;
          index += 2;
          continue;
        }
        value += character;
        index += 1;
        continue;
      }
      if (character === '"') {
        closed = true;
        index += 1;
        break;
      }
      value += character;
      index += 1;
    }

    if (!closed || !value.trim()) return null;
    fields.push(value.trim());
    if (fields.length > 4) return null;
  }

  return fields.length === 4 ? fields : null;
}

export function parseCommand(text) {
  const prefix = text.match(/^\/addmodel(?:@\w+)?(?:\s+|$)/i);
  if (!prefix) return null;
  const fields = parseQuotedFields(text.slice(prefix[0].length));
  if (!fields) return null;

  const [name, baseURL, modelID, apiKey] = fields;
  return {
    id: deriveProviderId(name),
    name,
    baseURL,
    modelID,
    apiKey,
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
    await ctx.reply("❌ I could not delete the submitted command, so no provider was added. Please delete that message manually and try again.");
    return;
  }

  if (!values) {
    await ctx.reply(
      "Format:\n/addmodel \"Provider Name\" \"https://example.com/v1\" \"model-name\" \"API_KEY\"\n\nAll four quoted values are required. The provider ID is generated from the name. Your submitted command is deleted after receipt.",
    );
    return;
  }

  const args = [
    MANAGER, "add",
    "--id", values.id,
    "--name", values.name,
    "--base-url", values.baseURL,
  ];
  args.push("--model-id", values.modelID);

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
