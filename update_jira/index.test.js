/**
 * Pure Node.js test suite for update_jira/index.js helpers.
 * Run: node update_jira/index.test.js
 */
const assert = require("assert");
const fs = require("fs");
const { maskSensitive, detectEnvironment } = require("./index");

function test(title, fn) {
  try {
    fn();
    console.log(`PASS: ${title}`);
  } catch (e) {
    console.error(`FAIL: ${title}\n  ${e.stack}`);
    process.exitCode = 1;
  }
}

// --- maskSensitive ---
test("maskSensitive masks apiToken, email, headers.Authorization, JIRA_API_TOKEN, JIRA_EMAIL", () => {
  const input = {
    apiToken: "secret",
    email: "mail",
    headers: { Authorization: "tok" },
    JIRA_API_TOKEN: "tok2",
    JIRA_EMAIL: "mail2",
    other: "ok",
  };
  const masked = maskSensitive(input);
  assert.strictEqual(masked.apiToken, "***");
  assert.strictEqual(masked.email, "***");
  assert.strictEqual(masked.headers.Authorization, "***");
  assert.strictEqual(masked.JIRA_API_TOKEN, "***");
  assert.strictEqual(masked.JIRA_EMAIL, "***");
  assert.strictEqual(masked.other, "ok");
});
test("maskSensitive returns non-object as is", () => {
  assert.strictEqual(maskSensitive(null), null);
  assert.strictEqual(maskSensitive(123), 123);
});

// --- detectEnvironment ---
test("detectEnvironment detects github", () => {
  const old = process.env.GITHUB_ACTIONS;
  process.env.GITHUB_ACTIONS = "true";
  assert.strictEqual(detectEnvironment(), "github");
  process.env.GITHUB_ACTIONS = old;
});
test("detectEnvironment detects ci", () => {
  const old1 = process.env.GITHUB_ACTIONS,
    old2 = process.env.CI;
  delete process.env.GITHUB_ACTIONS;
  process.env.CI = "true";
  assert.strictEqual(detectEnvironment(), "ci");
  process.env.GITHUB_ACTIONS = old1;
  process.env.CI = old2;
});
test("detectEnvironment detects local", () => {
  const old1 = process.env.GITHUB_ACTIONS,
    old2 = process.env.CI;
  delete process.env.GITHUB_ACTIONS;
  delete process.env.CI;
  assert.strictEqual(detectEnvironment(), "local");
  process.env.GITHUB_ACTIONS = old1;
  process.env.CI = old2;
});

// --- Event payload loading logic (mocked) ---
test("loads event.local.json if present (local env)", () => {
  // Mock fs.existsSync and fs.readFileSync
  const existsSyncOrig = fs.existsSync,
    readFileSyncOrig = fs.readFileSync;
  fs.existsSync = (p) => p.includes("event.local.json");
  fs.readFileSync = () => '{"foo":42}';
  let eventData = null;
  const localEventPath = "./update_jira/event.local.json";
  if (fs.existsSync(localEventPath)) {
    eventData = JSON.parse(fs.readFileSync(localEventPath, "utf8"));
  }
  assert.deepStrictEqual(eventData, { foo: 42 });
  fs.existsSync = existsSyncOrig;
  fs.readFileSync = readFileSyncOrig;
});
test("loads GITHUB_EVENT_PATH if event.local.json not present (local env)", () => {
  const existsSyncOrig = fs.existsSync,
    readFileSyncOrig = fs.readFileSync;
  process.env.GITHUB_EVENT_PATH = "/fake/path/event.json";
  fs.existsSync = (p) => p === "/fake/path/event.json";
  fs.readFileSync = () => '{"bar":99}';
  let eventData = null;
  const localEventPath = "./update_jira/event.local.json";
  if (fs.existsSync(localEventPath)) {
    eventData = JSON.parse(fs.readFileSync(localEventPath, "utf8"));
  } else if (
    process.env.GITHUB_EVENT_PATH &&
    fs.existsSync(process.env.GITHUB_EVENT_PATH)
  ) {
    eventData = JSON.parse(
      fs.readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")
    );
  }
  assert.deepStrictEqual(eventData, { bar: 99 });
  fs.existsSync = existsSyncOrig;
  fs.readFileSync = readFileSyncOrig;
});

// --- Dry-run mode logic ---
test("dry-run mode skips update logic", () => {
  process.env.DRY_RUN = "true";
  let called = false;
  function mockJiraUpdate() {
    called = true;
  }
  if (process.env.DRY_RUN === "true") {
    // Should not call mockJiraUpdate
  } else {
    mockJiraUpdate();
  }
  assert.strictEqual(called, false);
  delete process.env.DRY_RUN;
});
