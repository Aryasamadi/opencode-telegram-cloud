import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANAGER = path.join(ROOT, "scripts", "provider-manager.mjs");

export async function removeProviderCommand(ctx) {
  const message = ctx.message;
  if (!message?.text) return;

  const match = message.text.match(/^\/removeprovider(?:@\w+)?\s+([a-z0-9][a-z0-9._-]{0,63})\s*$/i);
  if (!match) {
    await ctx.reply("Format: /removeprovider provider-id\nExample: /removeprovider nvidia");
    return;
  }

  const providerId = match[1];
  await ctx.reply(`⏳ Removing provider "${providerId}"…`);

  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [MANAGER, "remove", "--id", providerId], {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout = (stdout + chunk).slice(0, 3000); });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15000);
    child.once("error", (error) => { clearTimeout(timeout); resolve({ code: -1, stdout: "", stderr: error.message }); });
    child.once("close", (code) => { clearTimeout(timeout); resolve({ code: code ?? -1, stdout, stderr }); });
  });

  if (result.code !== 0) {
    await ctx.reply(`❌ Could not remove provider.\n${(result.stderr || "Unknown error").slice(-1500)}`);
    return;
  }

  await ctx.reply(`✅ ${result.stdout.trim()}\n\nOpen the model picker and tap 🗂 Providers. The provider list will refresh automatically.`);
}
