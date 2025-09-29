const core = require('@actions/core')
const github = require('@actions/github')
const { Octokit } = require('@octokit/rest')
const Jira = require('./../utils/jira')

const stagingReleaseEnvId = '11942'
const prodReleaseEnvId = '11943'

const statusMap = {
  'master': {
    status: 'Done',
    transitionFields: {
      resolution: 'Done'
    },
    customFields: {
      // prod release timestamp
      customfield_11475: new Date(),
      customfield_11473: { id: prodReleaseEnvId }
    }
  },
  'main': {
    status: 'Done',
    transitionFields: {
      resolution: 'Done'
    },
    customFields: {
      // prod release timestamp
      customfield_11475: new Date(),
      customfield_11473: { id: prodReleaseEnvId }
    }
  },
  'staging': {
    status: 'Deployed to Staging',
    transitionFields: {
      resolution: 'Done'
    },
    customFields: {
      // staging release timestamp
      customfield_11474: new Date(),
      customfield_11473: { id: stagingReleaseEnvId }
    }
  },
  'dev': {
    status: 'Deployed to Dev',
    transitionFields: {
      resolution: 'Done'
    },
    customFields: {}
  }
}

run()

async function run() {
  try {
    const {
      GITHUB_REF,
      GITHUB_EVENT_NAME,
      GITHUB_EVENT_PATH,
      GITHUB_REPOSITORY,
      GITHUB_TOKEN,
    } = process.env

    const JIRA_BASE_URL = core.getInput('JIRA_BASE_URL')
    const JIRA_EMAIL = core.getInput('JIRA_EMAIL')
    const JIRA_API_TOKEN = core.getInput('JIRA_API_TOKEN')

    const jiraUtil = new Jira({
      baseUrl: JIRA_BASE_URL,
      email: JIRA_EMAIL,
      apiToken: JIRA_API_TOKEN,
    })

    if (GITHUB_EVENT_NAME === 'pull_request' || GITHUB_EVENT_NAME === 'pull_request_target') {
      const eventData = require(GITHUB_EVENT_PATH)
      await handlePullRequestEvent(eventData, jiraUtil, GITHUB_REPOSITORY)
      return
    }

    const allowedBranches = [
      'refs/heads/master',
      'refs/heads/main',
      'refs/heads/staging',
      'refs/heads/dev',
    ]

    if (allowedBranches.indexOf(GITHUB_REF) !== -1) {
      const branchName = GITHUB_REF.split('/').pop()
      await handlePushEvent(branchName, jiraUtil, GITHUB_REPOSITORY, GITHUB_TOKEN)
    }
  } catch (error) {
    core.setFailed(error.message)
  }
}

/**
 * Prepare fields for Jira transition, converting names to IDs where needed
 */
async function prepareFields(fields, jiraUtil) {
  const preparedFields = {}

  for (const [fieldName, fieldValue] of Object.entries(fields)) {
    if (fieldName === 'resolution' && typeof fieldValue === 'string') {
      // Look up resolution ID by name
      const resolutions = await jiraUtil.getFieldOptions('resolution')
      const resolution = resolutions.find(r => r.name === fieldValue)
      if (resolution) {
        preparedFields.resolution = { id: resolution.id }
      } else {
        console.warn(`Resolution "${fieldValue}" not found`)
      }
    } else if (fieldName === 'priority' && typeof fieldValue === 'string') {
      // Look up priority ID by name
      const priorities = await jiraUtil.getFieldOptions('priority')
      const priority = priorities.find(p => p.name === fieldValue)
      if (priority) {
        preparedFields.priority = { id: priority.id }
      }
    } else if (fieldName === 'assignee' && typeof fieldValue === 'string') {
      // For assignee, you might need to look up the user
      // This depends on your Jira configuration
      preparedFields.assignee = { name: fieldValue }
    } else {
      // Pass through other fields as-is
      preparedFields[fieldName] = fieldValue
    }
  }

  return preparedFields
}

/**
 * Update issue with transition and then update custom fields separately
 */
async function updateIssueWithCustomFields(jiraUtil, issueKey, targetStatus, excludeStates, transitionFields, customFields) {
  try {
    // First, transition the issue with only transition-allowed fields
    const preparedTransitionFields = await prepareFields(transitionFields, jiraUtil)
    await jiraUtil.transitionIssue(issueKey, targetStatus, excludeStates, preparedTransitionFields)

    // Then, if there are custom fields to update, update them separately
    if (customFields && Object.keys(customFields).length > 0) {
      await jiraUtil.updateCustomFields(issueKey, customFields)
    }

    return true
  } catch (error) {
    console.error(`Failed to update ${issueKey}:`, error.message)
    throw error
  }
}

/**
 * Handle pull request events (open, close, etc)
 */
async function handlePullRequestEvent(eventData, jiraUtil) {
  const { action, pull_request } = eventData

  const issueKeys = extractJiraIssueKeys(pull_request)
  if (issueKeys.length === 0) {
    console.log('No Jira issue keys found in PR')
    return
  }

  console.log(`Found Jira issues: ${issueKeys.join(', ')}`)

  let targetStatus = null
  let transitionFields = {}
  let customFields = {}
  const targetBranch = pull_request.base.ref

  switch (action) {
    case 'opened':
    case 'reopened':
    case 'ready_for_review':
      targetStatus = 'Code Review'
      break
    case 'converted_to_draft':
      targetStatus = 'In Development'
      break
    case 'synchronize':
      if (!pull_request.draft) {
        targetStatus = 'Code Review'
      }
      break
    case 'closed':
      if (pull_request.merged) {
        const branchConfig = statusMap[targetBranch]
        if (branchConfig) {
          targetStatus = branchConfig.status
          transitionFields = branchConfig.transitionFields || {}
          customFields = branchConfig.customFields || {}
        } else {
          targetStatus = 'Done'
          transitionFields = { resolution: 'Done' }
        }
      } else {
        console.log('PR closed without merging, skipping status update')
        return
      }
      break
    default:
      console.log('No status updates for action:', action)
      break
  }

  if (targetStatus) {
    for (const issueKey of issueKeys) {
      try {
        await updateIssueWithCustomFields(
          jiraUtil,
          issueKey,
          targetStatus,
          ['Blocked', 'Rejected'],
          transitionFields,
          customFields
        )
      } catch (error) {
        console.error(`Failed to update ${issueKey}:`, error.message)
      }
    }
  }
}

/**
 * Handle push events to branches
 */
async function handlePushEvent(branch, jiraUtil, githubRepository, githubToken) {
  const octokit = new Octokit({
    auth: githubToken,
  })

  const [githubOwner, repositoryName] = githubRepository.split('/')
  const { data } = await octokit.rest.repos.getCommit({
    owner: githubOwner,
    repo: repositoryName,
    ref: branch,
    perPage: 1,
    page: 1,
  })

  const { commit: { message: commitMessage } } = data
  const branchConfig = statusMap[branch]
  if (!branchConfig) {
    console.log(`No status mapping for branch: ${branch}`)
    return
  }

  const newStatus = branchConfig.status
  const transitionFields = branchConfig.transitionFields || {}
  const customFields = branchConfig.customFields || {}

  const shouldCheckCommitHistory = ['master', 'main', 'staging'].includes(branch)

  const prMatch = commitMessage.match(/#([0-9]+)/)

  // Handle staging to production deployment
  if ((branch === 'master' || branch === 'main')) {
    console.log('Production deployment: extracting issues from commit history')

    try {
      const commitHistoryIssues = await jiraUtil.getIssueKeysFromCommitHistory('HEAD~100', 'HEAD')
      if (commitHistoryIssues.length > 0) {
        console.log(`Found ${commitHistoryIssues.length} issues in production commit history`)

        const updateResults = await updateIssuesFromCommitHistoryWithCustomFields(
          jiraUtil,
          commitHistoryIssues,
          newStatus,
          ['Blocked', 'Rejected'],
          transitionFields,
          customFields
        )

        console.log(`Production deployment results: ${updateResults.successful} successful, ${updateResults.failed} failed`)
      } else {
        console.log('No Jira issues found in production commit history')
      }
    } catch (error) {
      console.error('Error processing production commit history:', error.message)
    }

    // Also handle direct PR merges to production
    if (prMatch) {
      const prNumber = extractPrNumber(commitMessage)
      const prUrl = `${repositoryName}/pull/${prNumber}`
      if (prNumber) {
        console.log(`Also updating issues from PR ${prUrl} to production status`)
        await updateByPRWithCustomFields(jiraUtil, prUrl, newStatus, transitionFields, customFields)
      }
    }
    return
  }

  // Handle dev to staging deployment
  if (branch === 'staging') {
    console.log('Staging deployment: extracting issues from commit history')

    try {
      // Get issue keys from commit history
      const commitHistoryIssues = await jiraUtil.extractIssueKeysFromGitHubContext(github.context)
      if (commitHistoryIssues.length > 0) {
        console.log(`Found ${commitHistoryIssues.length} issues in staging commit history`)

        // Update issues found in commit history
        const updateResults = await updateIssuesFromCommitHistoryWithCustomFields(
          jiraUtil,
          commitHistoryIssues,
          newStatus,
          ['Blocked', 'Rejected'],
          transitionFields,
          customFields
        )

        console.log(`Staging deployment results: ${updateResults.successful} successful, ${updateResults.failed} failed`)
        return
      } else {
        console.log('No Jira issues found in staging commit history')
        return
      }
    } catch (error) {
      console.error('Error processing staging commit history:', error.message)
    }

    // Also handle direct PR merges to staging
    if (prMatch) {
      const prNumber = prMatch[1]
      const prUrl = `${repositoryName}/pull/${prNumber}`
      console.log(`Also updating issues from PR ${prUrl} to staging status`)
      await updateByPRWithCustomFields(jiraUtil, prUrl, newStatus, transitionFields, customFields)
    }
    return
  }

  // Handle PR merges to other branches (like dev)
  if (prMatch) {
    const prNumber = prMatch[1]
    const prUrl = `${repositoryName}/pull/${prNumber}`
    console.log(`Updating issues mentioning PR ${prUrl} to status: ${newStatus}`)
    await updateByPRWithCustomFields(jiraUtil, prUrl, newStatus, transitionFields, customFields)
  }

  // Additionally, for important branches, check commit history for issue keys
  if (shouldCheckCommitHistory) {
    try {
      // Get issue keys from recent commit history (last 50 commits)
      const commitHistoryIssues = await jiraUtil.getIssueKeysFromCommitHistory('HEAD~50', 'HEAD')

      if (commitHistoryIssues.length > 0) {
        console.log(`Found ${commitHistoryIssues.length} additional issues in commit history for ${branch} branch`)

        // Update issues found in commit history
        const updateResults = await updateIssuesFromCommitHistoryWithCustomFields(
          jiraUtil,
          commitHistoryIssues,
          newStatus,
          ['Blocked', 'Rejected'],
          transitionFields,
          customFields
        )

        console.log(`Commit history update results: ${updateResults.successful} successful, ${updateResults.failed} failed`)
      }
    } catch (error) {
      console.error('Error processing commit history:', error.message)
      // Don't fail the entire action if commit history processing fails
    }
  }
}

/**
 * Update issues from commit history with separate custom field updates
 */
async function updateIssuesFromCommitHistoryWithCustomFields(jiraUtil, issueKeys, targetStatus, excludeStates, transitionFields, customFields) {
  if (!issueKeys || issueKeys.length === 0) {
    console.log('No issue keys provided for update')
    return { successful: 0, failed: 0, errors: [] }
  }

  console.log(`Updating ${issueKeys.length} issues to status: ${targetStatus}`)

  const results = await Promise.allSettled(
    issueKeys.map(issueKey =>
      updateIssueWithCustomFields(jiraUtil, issueKey, targetStatus, excludeStates, transitionFields, customFields)
    )
  )

  const successful = results.filter(result => result.status === 'fulfilled').length
  const failed = results.filter(result => result.status === 'rejected')
  const errors = failed.map(result => result.reason?.message || 'Unknown error')

  console.log(`Update summary: ${successful} successful, ${failed.length} failed`)
  if (failed.length > 0) {
    console.log('Failed updates:', errors)
  }

  return {
    successful,
    failed: failed.length,
    errors
  }
}

/**
 * Update issues by PR with separate custom field updates
 */
async function updateByPRWithCustomFields(jiraUtil, prUrl, newStatus, transitionFields, customFields) {
  try {
    let jql = `text ~ "${prUrl}"`
    const response = await jiraUtil.request('/search/jql', {
      method: 'POST',
      body: JSON.stringify({
        jql,
        fields: ['key', 'summary', 'status', 'description'],
        maxResults: 50
      })
    })

    const data = await response.json()
    const issues = data.issues
    console.log(`Found ${issues.length} issues mentioning PR ${prUrl}`)

    for (const issue of issues) {
      await updateIssueWithCustomFields(
        jiraUtil,
        issue.key,
        newStatus,
        ['Blocked', 'Rejected'],
        transitionFields,
        customFields
      )
    }

    return issues.length
  } catch (error) {
    console.error(`Error updating issues by PR:`, error.message)
    throw error
  }
}

/**
 * Extract Jira issue keys from PR title or body
 * @param {Object} pullRequest - GitHub PR object
 * @returns {Array<string>} Array of Jira issue keys
 */
function extractJiraIssueKeys(pullRequest) {
  const jiraKeyPattern = /[A-Z]+-[0-9]+/g
  const keys = new Set()

  if (pullRequest.title) {
    const titleMatches = pullRequest.title.match(jiraKeyPattern)
    if (titleMatches) {
      titleMatches.forEach(key => keys.add(key))
    }
  }

  return Array.from(keys)
}

/**
 * Extract PR number from commit message
 * @param {string} commitMessage - Git commit message
 * @returns {string|null} PR number or null if not found
 */
function extractPrNumber(commitMessage) {
  const prMatch = commitMessage.match(/#([0-9]+)/)
  return prMatch ? prMatch[1] : null
}
