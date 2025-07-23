const axios = require('axios')

class Jira {
  constructor({ baseUrl, email, apiToken, projectKey }) {
    this.baseUrl = baseUrl
    this.email = email
    this.apiToken = apiToken
    this.projectKey = projectKey

    this.client = axios.create({
      baseURL: `${baseUrl}/rest/api/3`,
      headers: {
        'Authorization': `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      }
    })
  }

  /**
   * Get available transitions for a Jira issue
   * @param {string} issueKey - Jira issue key (e.g., PROJ-123)
   * @returns {Promise<Array>} Available transitions
   */
  async getTransitions(issueKey) {
    try {
      const response = await this.client.get(`/issue/${issueKey}/transitions`)
      return response.data.transitions
    } catch (error) {
      console.error(`Error getting transitions for ${issueKey}:`, error.message)
      throw error
    }
  }

  /**
   * Transition a Jira issue to a new status
   * @param {string} issueKey - Jira issue key
   * @param {string} targetStatus - Name of the target status
   */
  async transitionIssue(issueKey, targetStatus) {
    try {
      const transitions = await this.getTransitions(issueKey)
      const transition = transitions.find(t =>
        t.to.name.toLowerCase() === targetStatus.toLowerCase()
      )

      if (!transition) {
        console.warn(`No transition found to status "${targetStatus}" for issue ${issueKey}`)
        return false
      }

      await this.client.post(`/issue/${issueKey}/transitions`, {
        transition: {
          id: transition.id
        }
      })

      console.log(`Successfully transitioned ${issueKey} to ${targetStatus}`)
      return true
    } catch (error) {
      console.error(`Error transitioning ${issueKey}:`, error.message)
      throw error
    }
  }

  /**
   * Search for issues with a specific status and update them
   * @param {string} currentStatus - Current status to search for
   * @param {string} newStatus - New status to transition to
   */
  async updateByStatus(currentStatus, newStatus) {
    try {
      let jql = `status = "${currentStatus}"`
      if (this.projectKey) {
        jql = `project = ${this.projectKey} AND ${jql}`
      }

      const response = await this.client.post('/search', {
        jql,
        fields: ['key', 'summary', 'status'],
        maxResults: 100
      })

      const issues = response.data.issues
      console.log(`Found ${issues.length} issues in "${currentStatus}" status`)

      for (const issue of issues) {
        await this.transitionIssue(issue.key, newStatus)
      }

      return issues.length
    } catch (error) {
      console.error(`Error updating issues by status:`, error.message)
      throw error
    }
  }

  /**
   * Find issues that mention a PR URL and update their status
   * @param {string} prUrl - PR URL to search for (e.g., "myrepo/pull/123")
   * @param {string} newStatus - New status to transition to
   */
  async updateByPR(prUrl, newStatus) {
    try {
      // This searches in description and comments
      let jql = `text ~ "${prUrl}"`
      if (this.projectKey) {
        jql = `project = ${this.projectKey} AND ${jql}`
      }

      const response = await this.client.post('/search', {
        jql,
        fields: ['key', 'summary', 'status', 'description'],
        maxResults: 50
      })

      const issues = response.data.issues
      console.log(`Found ${issues.length} issues mentioning PR ${prUrl}`)

      for (const issue of issues) {
        await this.transitionIssue(issue.key, newStatus)
      }

      return issues.length
    } catch (error) {
      console.error(`Error updating issues by PR:`, error.message)
      throw error
    }
  }
}

module.exports = Jira
