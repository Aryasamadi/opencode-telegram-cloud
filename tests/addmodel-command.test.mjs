import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "../scripts/addmodel-command.mjs";

test("parses the exact four quoted /addmodel arguments and derives provider ID", () => {
  assert.deepEqual(
    parseCommand('/addmodel "Provider Name" "https://example.com/v1" "model-name" "API_KEY"'),
    {
      id: "provider-name",
      name: "Provider Name",
      baseURL: "https://example.com/v1",
      modelID: "model-name",
      apiKey: "API_KEY",
    },
  );
});

test("supports bot suffixes and escaped quotes inside values", () => {
  assert.deepEqual(
    parseCommand(String.raw`/addmodel@my_test_bot "Provider \"One\"" "https://example.com/v1" "model-name" "key-value"`),
    {
      id: "provider-one",
      name: 'Provider "One"',
      baseURL: "https://example.com/v1",
      modelID: "model-name",
      apiKey: "key-value",
    },
  );
});

test("rejects missing quotes, missing fields, empty fields, and extra arguments", () => {
  assert.equal(parseCommand("/addmodel Provider https://example.com/v1 model key"), null);
  assert.equal(parseCommand('/addmodel "Provider" "https://example.com/v1" "model-name"'), null);
  assert.equal(parseCommand('/addmodel "Provider" "" "model-name" "key"'), null);
  assert.equal(parseCommand('/addmodel "Provider" "https://example.com/v1" "model-name" "key" "extra"'), null);
});
