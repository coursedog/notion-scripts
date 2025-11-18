# GitHub Actions for Jira Integration

This repository contains GitHub Actions for automating Jira issue management based on GitHub events.

## Actions

### update_jira

Automatically updates Jira issues based on pull request events and deployments.

**Features:**

- Transitions Jira issues based on PR status and target branch
- Updates deployment metadata (environment, timestamps) for staging/production releases
- Supports dry-run mode for testing
- Handles multiple Jira issues in PR titles/descriptions

**Configuration:**

```yaml
- uses: ./update_jira
  with:
    jira-base-url: ${{ secrets.JIRA_BASE_URL }}
    jira-email: ${{ secrets.JIRA_EMAIL }}
    jira-api-token: ${{ secrets.JIRA_API_TOKEN }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
    dry-run: 'false'
```

**Custom Fields:**

- `customfield_11473`: Release Environment (staging/production)
- `customfield_11474`: Stage Release Timestamp
- `customfield_11475`: Production Release Timestamp

**Local Testing:**

1. Copy `.env.example` to `.env` and fill in credentials
2. Create `update_jira/event.local.json` with a sample GitHub event
3. Run: `node update_jira/index.js`

**Verification Scripts:**

- `utils/verify-custom-fields.js`: Verify custom field IDs exist in your Jira instance
- `utils/test-custom-field-update.js`: Test custom field updates with rollback

**Integration Tests:**

Run comprehensive Jira API integration tests:

```bash
node utils/jira.integration.test.js
```

This test suite will:

- Test all Jira utility methods (workflows, transitions, custom fields, etc.)
- Capture the original state of your test issue before making changes
- Perform real API calls to your Jira instance
- Prompt you to rollback all changes at the end

**Required environment variables:**

- `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` (required)
- `TEST_JIRA_ISSUE_KEY` (default: `DEX-36`)
- `TEST_JIRA_PROJECT_KEY` (default: `DEX`)
- `TEST_JIRA_CUSTOM_FIELD` (default: `customfield_10001`)
- `TEST_JIRA_CUSTOM_VALUE` (default: `test-value`)
- `TEST_JIRA_STATUS` (default: `Done`)
- `TEST_JIRA_PR_URL` (optional)

Add these to your `.env` file before running the test.

## Development

**Prerequisites:**

- Node.js 16+
- Jira account with API token
- GitHub repository access

**Installation:**

```bash
npm install
```

**Environment Variables:**

See `.env.example` for required configuration.

## Related Tickets

- **DEX-36**: Fix GitHub <> JIRA integration malfunctions
- **ALL-593**: Push deployment metadata to Jira custom fields
