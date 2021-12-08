const { Client }= require('@notionhq/client')

class Notion {
  constructor ({ apiKey, databaseToken }) {
    // Retrieving all the input parameters relevant to notion
    this.notionDatabaseToken = databaseToken
      
    // Initializing the notion client
    this.client = new Client({ auth: apiKey })
    this.labels = {
      GITHUB_PR: 'GitHub PR',
      STATUS: 'Status',
      DATE_COMPLETED: 'Date Completed',
    }
  }

  /**
   * Function to update the status of a particular task from one to the other one
   *
   * @param {String} originalStatus Status from which the task is to be moved
   * @param {String} newStatus Status to which the status is to be moved
   */
  async updateByStatus (originalStatus, newStatus) {
    console.log('Updating all Notion tasks from', originalStatus, 'to', newStatus)
    const databaseId = this.notionDatabaseToken
    const {
      GITHUB_REPOSITORY,
    } = process.env
    const repositoryName = GITHUB_REPOSITORY.split('/').pop()

    const listOfTasks = await this.client.databases.query({
      database_id: databaseId,
      filter: {
        and: [
          {
            property: this.labels.STATUS,
            select: {
              equals: originalStatus,
            },
          },
          {
            property: this.labels.GITHUB_PR,
            text: {
              contains: repositoryName,
            },
          },
        ],
      },
    })
    for (let i = 0; i < listOfTasks.results.length; i++) {
      const updatedTasks = await this.client.pages.update({
        page_id: listOfTasks.results[i].id,
        properties: {
          Status: {
            select: {
              name: newStatus,
            },
          },
        },
      })
      console.log('Updated', updatedTasks)
    }
  }

  /**
   * Function to promote the task by the Github PR field
   *
   * @param {String} pr PR URL for which the status is to be updated
   * @param {String} newStatus New status to which the task is to be promoted
   */
  async updateByPR (pr, newStatus) {
    console.log('Updating one Notion task with PR', pr, 'to', newStatus)
    const databaseId = this.notionDatabaseToken
    const listOfTasks = await this.client.databases.query({
      database_id: databaseId,
      filter: {
        and: [
          {
            property: this.labels.GITHUB_PR,
            text: {
              contains: pr,
            },
          },
          {
            property: this.labels.STATUS,
            select: {
              does_not_equal: 'Completed (old)',
            },
          },
          {
            property: this.labels.STATUS,
            select: {
              does_not_equal: 'Completed (Production)',
            },
          },
        ],
      },
    })
    for (let i = 0; i < listOfTasks.results.length; i++) {
      const updatedTasks = await this.client.pages.update({
        page_id: listOfTasks.results[i].id,
        properties: {
          [this.labels.STATUS]: {
            select: {
              name: newStatus,
            },
          },
          [this.labels.DATE_COMPLETED]: {
            date: {
              start: new Date().toISOString(),
            },
          },
        },
      })
      console.log('Updated', updatedTasks)
    }
  }
  
}

module.exports = Notion
