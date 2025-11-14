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
