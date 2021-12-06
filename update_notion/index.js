const core = require('@actions/core')
const { Octokit } = require('@octokit/rest')

const Notion = require('./../utils/notion')

try {
  const {
    GITHUB_REF,
  } = process.env

  if (GITHUB_REF === 'refs/heads/master') {
    _updateNotionStatuses('master')
  } else if (GITHUB_REF === 'refs/heads/staging') {
    _updateNotionStatuses('staging')
  } else if (GITHUB_REF === 'refs/heads/dev') {
    _updateNotionStatuses('dev')
  }
} catch (error) {
  core.setFailed(error.message)
}

/**
 * Function to update the status of the tasks based on
 * the recent commit is getting merged to which branch
 *
 * @param {'dev' | 'staging' | 'master' } branch Name of the branch to which the commit is getting merged to
 */
async function _updateNotionStatuses (branch) {

  const {
    GITHUB_REPOSITORY,
    GITHUB_TOKEN,
    GITHUB_OWNER,
  } = process.env

  const octokit = new Octokit({
    auth: GITHUB_TOKEN,
  })

  const NOTION_DATABASE_TOKEN = core.getInput('NOTION_DATABASE_TOKEN')
  const NOTION_API_KEY = core.getInput('NOTION_API_KEY')

  const notionUtil = new Notion({
    apiKey: NOTION_API_KEY,
    databaseToken: NOTION_DATABASE_TOKEN,
  })

  const repositoryName = GITHUB_REPOSITORY.split('/').pop()
  console.log(repositoryName)
  
  // Get most recent commit to branch
  const { data } = await octokit.rest.repos.getCommit({
    owner: GITHUB_OWNER,
    repo: GITHUB_REPOSITORY,
    ref: branch,
    perPage: 1,
    page: 1,
  })

  const {
    commit: {
      message: commitMessage,
    },
  } = data

  switch (branch) {
    case 'master':
      if (commitMessage.includes('from coursedog/staging')) {
        // Update all tasks that are in Completed Staging to Completed Prod
        notionUtil.updateByStatus('Completed (Staging)', 'Completed (Production)')
      }
      break
    case 'staging':
      if (commitMessage.includes('from coursedog/dev')) {
        // Update all tasks that are in Completed Dev to Completed Staging
        notionUtil.updateByStatus('Completed (Dev)', 'Completed (Staging)')
      } else if (commitMessage.match(/#+[0-9]/)) {
        // direct from open PR to staging
        const prNumber = commitMessage.split('#')[1].replace(/\D/g, '')
        notionUtil.updateByPR(`${repositoryName}/pull/${prNumber}`, 'Completed (Staging)')
      }
      break
    case 'dev':
      if (commitMessage.match(/#+[0-9]/)) {
        // direct from open PR to dev
        const prNumber = commitMessage.split('#')[1].replace(/\D/g, '')
        notionUtil.updateByPR(`${repositoryName}/pull/${prNumber}`, 'Completed (Dev)')
      }
      break
  
    default:
      break
  }
}
