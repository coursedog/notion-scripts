const core = require('@actions/core')
const { Octokit } = require('@octokit/rest')
const Jira = require('./../utils/jira')

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

    console.log(GITHUB_EVENT_NAME)

    if (GITHUB_EVENT_NAME === 'pull_request' || GITHUB_EVENT_NAME === 'pull_request_target') {
      const eventData = require(GITHUB_EVENT_PATH)
      console.log(eventData)

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
      console.log('will handle push event!')
      const branchName = GITHUB_REF.split('/').pop()
      await handlePushEvent(branchName, jiraUtil, GITHUB_REPOSITORY, GITHUB_TOKEN)
    }
  } catch (error) {
    console.log('Failed to update task statuses:', error)
    core.setFailed(error.message)
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
    case 'synchronize': {
      if (!pull_request.draft) {
        targetStatus = 'Code Review'
      }
      break
    }
    case 'closed':
      if (pull_request.merged) {
        targetStatus = statusMap[targetBranch] || 'Done'
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
        await jiraUtil.transitionIssue(issueKey, targetStatus)
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
  console.log('HANDLING PUSH EVENT')
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
  const statusMap = {
    'master': 'Deployed to Production',
    'main': 'Deployed to Production',
    'staging': 'Deployed to Staging',
    'dev': 'Deployed to Staging'
  }

  const newStatus = statusMap[branch]
  if (!newStatus) {
    console.log(`No status mapping for branch: ${branch}`)
    return
  }

  // Handle special case: staging -> production bulk update
  if ((branch === 'master' || branch === 'main') && commitMessage.includes('from coursedog/staging')) {
    console.log('Bulk updating all Staging issues to Done')
    await jiraUtil.updateByStatus('Deployed to Staging', newStatus)
    return
  }

  // Handle PR merges (look for PR number in commit message)
  const prMatch = commitMessage.match(/#([0-9]+)/)
  if (prMatch) {
    const prNumber = prMatch[1]
    const prUrl = `${repositoryName}/pull/${prNumber}`
    console.log(`Updating issues mentioning PR ${prUrl} to status: ${newStatus}`)
    await jiraUtil.updateByPR(prUrl, newStatus)
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

