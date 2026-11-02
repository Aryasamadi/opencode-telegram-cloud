import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { reloadOpenCodeConfig } from "../scripts/reload-opencode-config.mjs";

test("reloads OpenCode V2 config through the authenticated location reload endpoint", async () => {
  let observed;
  const server = createServer((req, res) => {
    observed = { method: req.method, url: req.url, authorization: req.headers.authorization };
    res.writeHead(204);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    const result = await reloadOpenCodeConfig({
      OPENCODE_API_URL: `http://127.0.0.1:${address.port}`,
      OPENCODE_SERVER_USERNAME: "opencode",
      OPENCODE_SERVER_PASSWORD: "test-password",
    });
    assert.equal(result.status, 204);
    assert.equal(observed.method, "POST");
    assert.equal(observed.url, "/api/location/reload");
    assert.equal(observed.authorization, "Basic " + Buffer.from("opencode:test-password").toString("base64"));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("does not claim a reload when OpenCode rejects the request", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(503);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await assert.rejects(
      reloadOpenCodeConfig({
        OPENCODE_API_URL: `http://127.0.0.1:${address.port}`,
        OPENCODE_SERVER_USERNAME: "opencode",
        OPENCODE_SERVER_PASSWORD: "test-password",
      }),
      /HTTP 503/,
    );
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
