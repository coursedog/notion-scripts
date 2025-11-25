# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

This repository contains GitHub Actions for automating Jira issue management based on GitHub events. The primary action (`update_jira`) automatically updates Jira issues based on pull request events and deployments to different branches (main/master, staging, dev).

## Commands

### Development
```bash
# Install dependencies
npm install

# Run linting
npm run lint

# Fix linting errors automatically
npx eslint --ext .js . --fix
```

### Testing
```bash
# No unit tests configured yet (see package.json)

# Run integration tests (requires valid .env)
node utils/jira.integration.test.js

# Verify custom field IDs
node utils/verify-custom-fields.js

# Test custom field updates with rollback
node utils/test-custom-field-update.js [ISSUE_KEY]
```

### Local Testing of GitHub Action
```bash
# 1. Copy and configure environment
cp .env.example .env
# Edit .env with your credentials

# 2. Create sample GitHub event payload
# Create update_jira/event.local.json with test event data

# 3. Run the action locally
node update_jira/index.js
```

## Architecture

### Core Components

**`update_jira/index.js`** - Main GitHub Action entry point
- Detects environment (GitHub Actions, CI, or local)
- Handles two event types: `pull_request` and `push`
- Routes to appropriate handlers based on event type
- Manages Jira issue transitions and custom field updates
- Supports dry-run mode for testing

**`utils/jira.js`** - Enterprise-Grade Jira API Client (v2.0 - REFACTORED)
- **NEW**: Comprehensive enterprise-grade implementation with advanced features
- Core wrapper around Jira REST API v3
- Implements intelligent workflow state machine for issue transitions
- Handles authentication via Basic Auth (email + API token)

**NEW FEATURES IN v2.0:**
- **Enterprise Logging System**: Structured logging with DEBUG, INFO, WARN, ERROR levels
  - Contextual logging with operation tracking
  - Sensitive data masking (tokens, passwords, credentials)
  - Performance timing for all operations
  - Set log level via `logLevel` parameter: `new Jira({ ..., logLevel: 'DEBUG' })`

- **Custom Error Classes**: Typed errors for better error handling
  - `JiraApiError` - API request failures with status codes
  - `JiraTransitionError` - Issue transition failures with context
  - `JiraValidationError` - Input validation failures
  - `JiraWorkflowError` - Workflow configuration issues

- **Retry Logic & Rate Limiting**:
  - Exponential backoff for failed requests (3 attempts, 2x multiplier)
  - Automatic rate limit handling (429 responses)
  - Network error recovery

- **Auto-Populated Required Fields**: **CRITICAL BUG FIX**
  - Automatically detects required fields during transitions
  - Auto-populates Resolution field with sensible defaults
  - Fixes 400 Bad Request errors for staging deployments

- **Per-Project State Machine Caching**:
  - Fixed: Now caches workflows per-project instead of single global cache
  - Prevents conflicts when working with multiple projects

- **Comprehensive Input Validation**:
  - All public methods validate inputs before processing
  - Issue key format validation (PROJECT-123)
  - Parameter type checking and sanitization

- **Edge Case Handling**:
  - Circular workflow dependency detection
  - Max path depth limiting (prevents infinite loops)
  - Graceful handling of git command failures
  - Empty result handling throughout

Key capabilities:
  - Workflow introspection (get workflows, state machines, transitions)
  - Issue transitions with multi-step path finding using BFS
  - Required field detection and auto-population
  - Custom field management
  - Issue search and retrieval
  - Field option lookups (resolutions, priorities, etc.)
  - Git integration (commit history parsing)

### Workflow Logic

**Branch → Status Mapping:**
- `master`/`main` → "Done" status + Production Release Timestamp
- `staging` → "In Staging" status + Stage Release Timestamp
- `dev` → "In Dev" status (no deployment timestamps)

**Pull Request Events:**
- Extracts Jira issue keys from PR title/description
- Opens issues when PR is opened
- Closes issues when PR is merged (transitions based on target branch)

**Push Events:**
- Extracts Jira issue keys from commit history (last 20 commits)
- Transitions issues to appropriate status for the branch
- Sets deployment metadata (environment, timestamps) using custom fields

### Custom Fields (ALL-593)

The action updates these Jira custom fields for deployment tracking:
- `customfield_11473`: Release Environment (select: staging ID=11942, production ID=11943)
- `customfield_11474`: Stage Release Timestamp (datetime)
- `customfield_11475`: Production Release Timestamp (datetime)

**Important:** Custom fields cannot be updated during issue transitions in Jira API. The code handles this by:
1. First transitioning the issue with only transition-allowed fields (like `resolution`)
2. Then updating custom fields in a separate API call

### State Machine & Transitions

The Jira utility builds a complete workflow state machine that maps:
- All statuses in a workflow
- All possible transitions between statuses
- A transition map for quick lookups: `Map<fromStatusId, Map<toStatusId, transition>>`

When transitioning issues, it can:
- Find direct transitions (single step)
- Find multi-step paths if no direct transition exists
- Use depth-first search to discover all possible paths
- Execute transitions sequentially when multiple steps are needed

### Issue Key Extraction

The action extracts Jira issue keys from:
- PR titles and descriptions (format: `DEX-123`, `ALL-456`, etc.)
- Commit messages in the git history
- Supports multiple issues per PR/commit

Pattern: `[A-Z]+-[0-9]+` (project key + issue number)

## Code Style

ESLint is configured with specific rules:
- 2-space indentation
- Single quotes (with template literal support)
- No semicolons
- Array brackets always have spaces: `[ 1, 2, 3 ]`
- Object curly braces have spaces: `{ key: value }`
- Max line length: 140 characters
- Prefer const over let
- Prefer template literals over concatenation

Run `npm run lint` before committing changes.

## Environment Variables

See `.env.example` for all configuration options. Key variables:

**Required:**
- `JIRA_BASE_URL` - Jira instance URL (e.g., https://coursedog.atlassian.net)
- `JIRA_EMAIL` - Email for Jira authentication
- `JIRA_API_TOKEN` - Jira API token
- `GITHUB_TOKEN` - Required for fetching commit data

**Optional:**
- `JIRA_PROJECT_KEY` - Limit searches to specific project
- `DRY_RUN` - Set to 'true' to log actions without executing them
- `DEBUG` - Set to 'true' to enable verbose DEBUG level logging (v2.0+)

**Local Testing:**
- `GITHUB_REF` - Branch reference (e.g., refs/heads/staging)
- `GITHUB_EVENT_NAME` - Event type (push, pull_request)
- `GITHUB_EVENT_PATH` - Path to event payload JSON
- `GITHUB_REPOSITORY` - Repository in owner/repo format

## Related Tickets

- **DEX-36**: Fix GitHub ↔ JIRA integration malfunctions
- **ALL-593**: Push deployment metadata to Jira custom fields
- **DEX-37**: Remove unused Notion integration
