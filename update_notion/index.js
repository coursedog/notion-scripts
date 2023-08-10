const core = require('@actions/core')
const { Octokit } = require('@octokit/rest')

const Notion = require('./../utils/notion')

try {
  const {
    GITHUB_REF,
  } = process.env

  const allowedBranches = [
    'refs/heads/master',
    'refs/heads/main',
    'refs/heads/staging',
    'refs/heads/dev',
  ]

  if (allowedBranches.indexOf(GITHUB_REF) !== -1) {
    const branchName = GITHUB_REF.split('/').pop()
    _updateNotionStatuses(branchName)
  }
} catch (error) {
  core.setFailed(error.message)
}

function extractPrNumber (commitMessage) {
  // get pr number from commit message
  const match  = commitMessage.match(/#(\d+)/)

  if (match && match.length) {
    return Number(match[0].substring(1))
  }
  return undefined
}

const repoNameToNotionDatabaseProperty = {
  'coursedogv3': 'CoursedogV3 PR',
  'coursedog-catalog': 'Coursedog Catalog PR',
}

const repoNameToPRStatusLink = {
  'coursedogv3': {
    Open: '951fe09381834d8eb24a500537b5a5ca',
    Merged: '85e90beb439c4897badd4e5effb73a89',
  },
  'coursedog-catalog': {
    Open: '6d90bd1de3b64b09ac082f87e899c5bc',
    Merged: '49e183df17dd4995bac9edac14e1ac5c',
  },
}

async function updatePRStatus (prNumber, status) {
  const NOTION_DATABASE_TOKEN = core.getInput('NOTION_DATABASE_TOKEN')
  const NOTION_API_KEY = core.getInput('NOTION_API_KEY')
  const NOTION_PR_DATABASE_TOKEN = core.getInput('NOTION_PR_DATABASE_TOKEN') || 'd1a47b75a15c438ebae10cd57c8f1101'
  const { GITHUB_REPOSITORY } = process.env
  const [ repositoryName ] = GITHUB_REPOSITORY.split('/')

  const masterTaskDatabase = new Notion({
    apiKey: NOTION_API_KEY,
    databaseToken: NOTION_DATABASE_TOKEN,
  })

  const linkToPR = `${repositoryName}/pull/${prNumber}`
  // Check if there is a task with the PR number
  //  If there is, update the status of the task
  const taskWithPRNumber = await masterTaskDatabase.getTaskByGithubPRInput(linkToPR)
  if (taskWithPRNumber && taskWithPRNumber.results.length) {
    await masterTaskDatabase.updateByPR(linkToPR, status)
    return
  }

  const coursedogV3PRDatabaseNotionUtil = new Notion({
    apiKey: NOTION_API_KEY,
    databaseToken: NOTION_PR_DATABASE_TOKEN,
  })
  //  If there isn't take the following steps:
  //    1. Search with the PR number in the PR database
  //    2. Get the relevant task IDs from the PR database
  //    3. Get the details of the tasks from the master task database
  //    4. Get the list of PRs from the task
  //    5. Check the status of the PRs
  //    6. If all the PR statuses are merged, update the status of the task
  const taskWithPRNumberFromMasterTask = await coursedogV3PRDatabaseNotionUtil.getPageByPRNumber(prNumber)
  const taskIds = taskWithPRNumberFromMasterTask.properties['Task']?.['relation'].map(
    (item) => item.id
  )
  const listOfTasks = await Promise.all(taskIds.map((eachTaskId) => masterTaskDatabase.getPageById(eachTaskId)))
  for (let index = 0; index < listOfTasks.length; index++) {
    const eachTask = listOfTasks[index]
    const listOfLinkedPRPageIds = eachTask.properties[repoNameToNotionDatabaseProperty[repositoryName]]?.['relation'].map(
      (item) => item.id
    )

    const listOfLinkedPRPages = await Promise
      .all(listOfLinkedPRPageIds
        .map((eachPRPageId) => coursedogV3PRDatabaseNotionUtil.getPageById(eachPRPageId))
      )

    const PRStatuses = listOfLinkedPRPages
      .map((eachPRPage) => eachPRPage
        .properties['State']
        .relation
        .map((item) => item.id)
      )
      .flat()
      .map((eachPRStatusId) => eachPRStatusId.replace(/-/g, ''))

    if (PRStatuses.every((status)=> status === repoNameToPRStatusLink[repositoryName]['Open'])) {
      await masterTaskDatabase.updateTaskStatusById(eachTask.id, status)
    }
  }
}

/**
 * Function to update the status of the tasks based on
 * the recent commit is getting merged to which branch
 *
 * @param {'main' | 'dev' | 'staging' | 'master' } branch Name of the branch to which the commit is getting merged to
 */
async function _updateNotionStatuses (branch) {

  const {
    GITHUB_REPOSITORY,
    GITHUB_TOKEN,
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

  const [ githubOwner, repositoryName ] = GITHUB_REPOSITORY.split('/')

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

  switch (branch) {
    case 'master':
    case 'main':
      if (commitMessage.includes('from coursedog/staging')) {
        // Update all tasks that are in Completed Staging to Completed Prod
        await notionUtil.updateByStatus('Completed (Staging)', 'Completed (Production)')
      } else if (commitMessage.match(/#+[0-9]/)) {
        // direct from open PR to staging
        const prNumber = extractPrNumber(commitMessage)
        if (!prNumber) return
        await updatePRStatus(prNumber, 'Completed (Production)')
      }
      break
    case 'staging':
      if (commitMessage.includes('from coursedog/dev')) {
        // Update all tasks that are in Completed Dev to Completed Staging
        await notionUtil.updateByStatus('Completed (Dev)', 'Completed (Staging)')
      } else if (commitMessage.match(/#+[0-9]/)) {
        // direct from open PR to staging
        const prNumber = extractPrNumber(commitMessage)
        if (!prNumber) return
        await updatePRStatus(prNumber, 'Completed (Staging)')
      }
      break
    case 'dev':
      if (commitMessage.match(/#+[0-9]/)) {
        // direct from open PR to dev
        const prNumber = extractPrNumber(commitMessage)
        if (!prNumber) return
        await updatePRStatus(prNumber, 'Completed (Dev)')
      }
      break

    default:
      break
  }
}
