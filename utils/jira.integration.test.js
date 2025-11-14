/**
 * Jira Integration Test Suite
 *
 * Comprehensive integration tests for the Jira utility class.
 * Intended for local/manual runs (not CI unit tests) and covers real API calls.
 *
 * Usage:
 *   node utils/jira.integration.test.js
 *
 * NOTE: Requires valid .env configuration with Jira credentials and test issue/project keys.
 *
 * At the end, you can revert all changes made by this test by answering 'yes' to the prompt.
 */

require("dotenv").config();
const Jira = require("./jira");

/**
 * Mask sensitive data in logs.
 * @param {object} obj
 * @returns {object}
 */
function maskSensitive(obj) {
  const clone =
    typeof structuredClone === "function"
      ? structuredClone(obj)
      : JSON.parse(JSON.stringify(obj));
  if (clone.apiToken) clone.apiToken = "***";
  if (clone.email) clone.email = "***";
  if (clone.headers?.Authorization) clone.headers.Authorization = "***";
  return clone;
}

/**
 * Log a section header for test output.
 * @param {string} title
 */
function logSection(title) {
  console.log("\n====================");
  console.log(title);
  console.log("====================");
}

/**
 * Capture the original state of the test issue for rollback.
 * @param {Jira} jira
 * @param {string} issueKey
 * @param {string} customField
 * @returns {Promise<{status: string, customFieldValue: any}>}
 */
async function captureOriginalIssueState(jira, issueKey, customField) {
  logSection("Capture original issue state for rollback");
  try {
    const issueResp = await jira.request(
      `/issue/${issueKey}?fields=status,${customField}`
    );
    const issueData = await issueResp.json();
    const status = issueData.fields.status.name;
    const customFieldValue = issueData.fields[customField];
    console.log(`Original status: ${status}`);
    console.log(`Original custom field (${customField}):`, customFieldValue);
    return { status, customFieldValue };
  } catch (err) {
    console.error("Failed to capture original state:", err.message);
    return { status: null, customFieldValue: null };
  }
}

/**
 * Rollback the test issue to its original state.
 * @param {Jira} jira
 * @param {string} issueKey
 * @param {string} customField
 * @param {any} originalCustomFieldValue
 * @param {string} originalStatus
 * @returns {Promise<void>}
 */
async function rollbackIssueState(
  jira,
  issueKey,
  customField,
  originalCustomFieldValue,
  originalStatus
) {
  logSection("ROLLBACK: Reverting all changes made by this test...");
  let rollbackErrors = false;
  try {
    await jira.updateCustomField(
      issueKey,
      customField,
      originalCustomFieldValue
    );
    console.log(
      `Rolled back custom field ${customField} to:`,
      originalCustomFieldValue
    );
  } catch (err) {
    console.error("Failed to rollback custom field:", err.message);
    rollbackErrors = true;
  }
  try {
    const issueResp = await jira.request(`/issue/${issueKey}?fields=status`);
    const issueData = await issueResp.json();
    const currentStatus = issueData.fields.status.name;
    if (originalStatus && currentStatus !== originalStatus) {
      await jira.transitionIssue(issueKey, originalStatus);
      console.log(`Rolled back status to: ${originalStatus}`);
    } else {
      console.log("No status rollback needed.");
    }
  } catch (err) {
    console.error("Failed to rollback status:", err.message);
    rollbackErrors = true;
  }
  if (rollbackErrors) {
    console.log("Rollback completed with errors. Check logs above.");
  } else {
    console.log("Rollback completed successfully.");
  }
}

/**
 * Main test runner for Jira integration tests.
 * Runs all test cases and handles rollback prompt.
 * @returns {Promise<void>}
 */

// Main test runner (top-level await for ESLint compliance)
const jira = new Jira({
  baseUrl: process.env.JIRA_BASE_URL,
  email: process.env.JIRA_EMAIL,
  apiToken: process.env.JIRA_API_TOKEN,
});

logSection("Jira instance created");
console.dir(maskSensitive(jira), { depth: 1 });

// Test configuration
const testIssueKey = process.env.TEST_JIRA_ISSUE_KEY || "DEX-36";
const testProjectKey = process.env.TEST_JIRA_PROJECT_KEY || "DEX";
const testCustomField =
  process.env.TEST_JIRA_CUSTOM_FIELD || "customfield_10001";
const testCustomValue = process.env.TEST_JIRA_CUSTOM_VALUE || "test-value";
const testStatus = process.env.TEST_JIRA_STATUS || "Done";
const testPRUrl =
  process.env.TEST_JIRA_PR_URL ||
  "https://github.com/coursedog/notion-scripts/pull/42";

// --- CAPTURE ORIGINAL STATE ---
const { status: originalStatus, customFieldValue: originalCustomFieldValue } =
  await captureOriginalIssueState(jira, testIssueKey, testCustomField);

// --- TEST CASES ---
try {
  logSection("Test: List all workflows");
  const workflows = await jira.getAllWorkflows();
  console.log(
    "Workflows:",
    workflows.map((w) => w.name || w.id)
  );
} catch (err) {
  console.error("getAllWorkflows error:", err.message);
}

try {
  logSection("Test: Get project workflow name");
  const wfName = await jira.getProjectWorkflowName(testProjectKey);
  console.log("Workflow name for project", testProjectKey, ":", wfName);
} catch (err) {
  console.error("getProjectWorkflowName error:", err.message);
}

try {
  logSection("Test: Get workflow state machine");
  const wfName = await jira.getProjectWorkflowName(testProjectKey);
  const sm = await jira.getWorkflowStateMachine(wfName);
  console.log("State machine states:", Object.keys(sm.states));
} catch (err) {
  console.error("getWorkflowStateMachine error:", err.message);
}

try {
  logSection("Test: Get available transitions for issue");
  const transitions = await jira.getTransitions(testIssueKey);
  console.log(
    "Transitions:",
    transitions.map((t) => `${t.name} → ${t.to.name}`)
  );
} catch (err) {
  console.error("getTransitions error:", err.message);
}

try {
  logSection("Test: Find issues by status");
  const issues = await jira.findByStatus(testStatus);
  console.log(
    "Issues in status",
    testStatus,
    ":",
    issues.map((i) => i.key)
  );
} catch (err) {
  console.error("findByStatus error:", err.message);
}

try {
  logSection("Test: List all statuses");
  const statuses = await jira.getAllStatuses();
  console.log(
    "Statuses:",
    statuses.map((s) => s.name)
  );
} catch (err) {
  console.error("getAllStatuses error:", err.message);
}

try {
  logSection('Test: Get field options for "resolution"');
  const options = await jira.getFieldOptions("resolution");
  console.log(
    "Resolution options:",
    options.map((o) => o.name)
  );
} catch (err) {
  console.error("getFieldOptions error:", err.message);
}

try {
  logSection("Test: Get workflow schema");
  const schema = await jira.getWorkflowSchema(testProjectKey);
  console.log("Workflow schema:", schema);
} catch (err) {
  console.error("getWorkflowSchema error:", err.message);
}

try {
  logSection("Test: Update custom field (may fail if value is invalid)");
  const res = await jira.updateCustomField(
    testIssueKey,
    testCustomField,
    testCustomValue
  );
  console.log("updateCustomField result:", res);
} catch (err) {
  console.error("updateCustomField error:", err.message);
}

try {
  logSection("Test: Get custom field value");
  const val = await jira.getCustomField(testIssueKey, testCustomField);
  console.log("Custom field value:", val);
} catch (err) {
  console.error("getCustomField error:", err.message);
}

try {
  logSection(
    "Test: Update multiple custom fields (may fail if value is invalid)"
  );
  const res = await jira.updateCustomFields(testIssueKey, {
    [testCustomField]: testCustomValue,
  });
  console.log("updateCustomFields result:", res);
} catch (err) {
  console.error("updateCustomFields error:", err.message);
}

try {
  logSection("Test: Get transition details for first available transition");
  const transitions = await jira.getTransitions(testIssueKey);
  if (transitions && transitions.length > 0) {
    const details = await jira.getTransitionDetails(
      testIssueKey,
      transitions[0].id
    );
    console.log("Transition details:", details);
  } else {
    console.log("No transitions to get details for");
  }
} catch (err) {
  console.error("getTransitionDetails error:", err.message);
}

try {
  logSection("Test: Extract issue keys from commit messages");
  const keys = jira.extractIssueKeysFromCommitMessages([
    "DEX-36: test commit",
    "ALL-123: another commit",
    "no key here",
  ]);
  console.log("Extracted keys:", keys);
} catch (err) {
  console.error("extractIssueKeysFromCommitMessages error:", err.message);
}

try {
  logSection("Test: Find all/shortest transition paths");
  const wfName = await jira.getProjectWorkflowName(testProjectKey);
  const sm = await jira.getWorkflowStateMachine(wfName);
  const allPaths = jira.findAllTransitionPaths(sm, "To Do", testStatus);
  const shortest = jira.findShortestTransitionPath(sm, "To Do", testStatus);
  console.log("All paths count:", allPaths.length);
  console.log("Shortest path:", shortest);
} catch (err) {
  console.error(
    "findShortestTransitionPath/findAllTransitionPaths error:",
    err.message
  );
}

try {
  logSection(
    "Test: Update issues by status (may fail if workflow transition not allowed)"
  );
  await jira.updateByStatus(testStatus, "In Progress", {});
} catch (err) {
  console.error("updateByStatus error:", err.message);
}

try {
  logSection("Test: Update issues by PR URL");
  await jira.updateByPR(testPRUrl, testStatus, {});
} catch (err) {
  console.error("updateByPR error:", err.message);
}

try {
  logSection("Test: Update issues from commit history");
  await jira.updateIssuesFromCommitHistory(["DEX-36", "ALL-123"], testStatus);
} catch (err) {
  console.error("updateIssuesFromCommitHistory error:", err.message);
}

try {
  logSection("Test: Transition issue to target status");
  await jira.transitionIssue(testIssueKey, testStatus);
} catch (err) {
  console.error("transitionIssue error:", err.message);
}

// --- END OF TEST CASES ---

logSection("TEST COMPLETE");
console.log("Do you want to revert all changes made by this test? (yes/no)");
process.stdin.setEncoding("utf8");
process.stdin.once("data", async (data) => {
  if (data.trim().toLowerCase() === "yes") {
    await rollbackIssueState(
      jira,
      testIssueKey,
      testCustomField,
      originalCustomFieldValue,
      originalStatus
    );
    process.exit(0);
  } else {
    console.log("No revert performed. All changes made by this test remain.");
    process.exit(0);
  }
});
