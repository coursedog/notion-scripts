const core = require('@actions/core')
const { Octokit } = require('@octokit/rest')
const Jira = require('./../utils/jira')

async function run() {
  try {
    const {
      GITHUB_REF,
      GITHUB_EVENT_NAME,
      GITHUB_EVENT_PATH,
    } = process.env

    if (GITHUB_EVENT_NAME === 'pull_request' || GITHUB_EVENT_NAME === 'pull_request_target') {
      const eventData = require(GITHUB_EVENT_PATH)

      if (eventData.pull_request && eventData.pull_request.draft) {
        console.log('PR is a draft, skipping Jira update')
        return
      }

      const JIRA_BASE_URL = core.getInput('JIRA_BASE_URL')
      const JIRA_USER_EMAIL = core.getInput('JIRA_USER_EMAIL')
      const JIRA_API_TOKEN = core.getInput('JIRA_API_TOKEN')
      const JIRA_PROJECT_KEY = core.getInput('JIRA_PROJECT_KEY')

      const jiraUtil = new Jira({
        baseUrl: JIRA_BASE_URL,
        email: JIRA_USER_EMAIL,
        apiToken: JIRA_API_TOKEN,
        projectKey: JIRA_PROJECT_KEY,
      })

      await handlePullRequestEvent(eventData, jiraUtil)
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
      await _updateJiraStatuses(branchName)
    }
  } catch (error) {
    core.setFailed(error.message)
  }
}

run()

function extractPrNumber(commitMessage) {
  const match = commitMessage
    .match(/#[0-9]{1,5}/)

  if (match && match.length) {
    return match[0].substring(1)
  }
  return undefined
}

/**
 * Function to update the status of the tasks based on
 * the recent commit is getting merged to which branch
 *
 * @param {'main' | 'dev' | 'staging' | 'master' } branch Name of the branch to which the commit is getting merged to
 */
async function _updateJiraStatuses(branch) {

  const {
    GITHUB_REPOSITORY,
    GITHUB_TOKEN,
  } = process.env

  const octokit = new Octokit({
    auth: GITHUB_TOKEN,
  })

  const JIRA_BASE_URL = core.getInput('JIRA_BASE_URL')
  const JIRA_USER_EMAIL = core.getInput('JIRA_USER_EMAIL')
  const JIRA_API_TOKEN = core.getInput('JIRA_API_TOKEN')
  const JIRA_PROJECT_KEY = core.getInput('JIRA_PROJECT_KEY')

  const jiraUtil = new Jira({
    baseUrl: JIRA_BASE_URL,
    email: JIRA_USER_EMAIL,
    apiToken: JIRA_API_TOKEN,
    projectKey: JIRA_PROJECT_KEY,
  })

  const [githubOwner, repositoryName] = GITHUB_REPOSITORY.split('/')

  // Get most recent commit to branch
  const { data } = await octokit.rest.repos.getCommit({
    owner: githubOwner,
    repo: repositoryName,
    ref: branch,
    perPage: 1,
    page: 1,
  })

  const {
    commit: {
      message: commitMessage,
    },
  } = data

  // Map branch names to Jira status names
  // You may need to adjust these based on your Jira workflow
  const statusMap = {
    'master': 'Done',
    'main': 'Done',
    'staging': 'Staging',
    'dev': 'Dev'
  }

  switch (branch) {
    case 'master':
    case 'main':
      if (commitMessage.includes('from coursedog/staging')) {
        // Update all tasks that are in Staging to Done
        await jiraUtil.updateByStatus('Staging', statusMap[branch])
      } else if (commitMessage.match(/#+[0-9]/)) {
        // direct from open PR to production
        const prNumber = extractPrNumber(commitMessage)
        if (!prNumber) return
        await jiraUtil.updateByPR(`${repositoryName}/pull/${prNumber}`, statusMap[branch])
      }
      break
    case 'staging':
      if (commitMessage.match(/#+[0-9]/)) {
        const prNumber = extractPrNumber(commitMessage)
        if (!prNumber) return
        await jiraUtil.updateByPR(`${repositoryName}/pull/${prNumber}`, statusMap[branch])
      }
      break
    case 'dev':
      if (commitMessage.match(/#+[0-9]/)) {
        // direct from open PR to dev
        const prNumber = extractPrNumber(commitMessage)
        if (!prNumber) return
        await jiraUtil.updateByPR(`${repositoryName}/pull/${prNumber}`, statusMap[branch])
      }
      break

    default:
      break
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

  if (pullRequest.body) {
    const bodyMatches = pullRequest.body.match(jiraKeyPattern)
    if (bodyMatches) {
      bodyMatches.forEach(key => keys.add(key))
    }
  }

  return Array.from(keys)
}

/**
 * Handle PR-specific Jira updates
 * @param {Object} eventData - GitHub event data
 * @param {Jira} jiraUtil - Jira utility instance
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
  const targetBranch = pull_request.base.ref

  switch (action) {
    case 'opened':
    case 'reopened':
      targetStatus = 'In Progress'
      break
    case 'ready_for_review':
      targetStatus = 'Code Review'
      break
    case 'closed':
      if (pull_request.merged) {
        targetStatus = statusMap[targetBranch] || 'Done'
      } else {
        console.log('PR closed without merging, skipping status update')
        return
      }
      break
  }

  if (targetStatus) {
    for (const issueKey of issueKeys) {
      try {
        await jiraUtil.transitionIssue(issueKey, targetStatus)

        const prComment = `Pull Request ${action}: [PR #${pull_request.number}|${pull_request.html_url}]`
        await jiraUtil.addComment(issueKey, prComment)
      } catch (error) {
        console.error(`Failed to update ${issueKey}:`, error.message)
      }
    }
  }
}
