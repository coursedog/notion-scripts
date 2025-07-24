class Jira {
  constructor({ baseUrl, email, apiToken, projectKey }) {
    this.baseUrl = baseUrl
    this.email = email
    this.apiToken = apiToken
    this.projectKey = projectKey
    this.baseURL = `${baseUrl}/rest/api/3`
    this.headers = {
      'Authorization': `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json'
    }
  }

  /**
   * Make an authenticated request to Jira API
   * @param {string} endpoint - API endpoint
   * @param {Object} options - Fetch options
   * @returns {Promise<any>} Response data
   */
  async request(endpoint, options = {}) {
    const url = `${this.baseURL}${endpoint}`
    const response = await fetch(url, {
      ...options,
      headers: {
        ...this.headers,
        ...options.headers
      }
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Jira API error: ${response.status} ${response.statusText} - ${errorText}`)
    }

    return response
  }

  /**
   * Get available transitions for a Jira issue
   * @param {string} issueKey - Jira issue key (e.g., PROJ-123)
   * @returns {Promise<Array>} Available transitions
   */
  async getTransitions(issueKey) {
    try {
      const response = await this.request(`/issue/${issueKey}/transitions`)
      const data = await response.json()
      return data.transitions
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
      const transition = transitions.find((t) =>
        t.to.name.toLowerCase() === targetStatus.toLowerCase()
      )
      if (!transition) {
        console.warn(`No transition found to status "${targetStatus}" for issue ${issueKey}`)
        return false
      }

      await this.request(`/issue/${issueKey}/transitions`, {
        method: 'POST',
        body: JSON.stringify({
          transition: {
            id: transition.id
          }
        })
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

      const response = await this.request('/search', {
        method: 'POST',
        body: JSON.stringify({
          jql,
          fields: ['key', 'summary', 'status'],
          maxResults: 100
        })
      })

      const data = await response.json()
      const issues = data.issues
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

      const response = await this.request('/search', {
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
        await this.transitionIssue(issue.key, newStatus)
      }

      return issues.length
    } catch (error) {
      console.error(`Error updating issues by PR:`, error.message)
      throw error
    }
  }

    /**
   * Get workflow schema for a project
   * @param {string} projectKey - Jira project key
   * @returns {Promise<Object>} Workflow information
   */
  async getWorkflowSchema(projectKey) {
    try {
      // Get project details to find issue types
      const project = await this.request(`/project/${projectKey}`)
      const projectData = await project.json()

      // Get workflow schemes
      const workflowResponse = await this.request(`/workflowscheme/project?projectId=${projectData.id}`)
      const workflowData = await workflowResponse.json()

      return workflowData
    } catch (error) {
      console.error(`Error getting workflow schema:`, error.message)
      throw error
    }
  }

  /**
   * Get all statuses in the workflow
   * @returns {Promise<Array>} All available statuses
   */
  async getAllStatuses() {
    try {
      const response = await this.request('/status')
      const statuses = await response.json()
      return statuses
    } catch (error) {
      console.error(`Error getting statuses:`, error.message)
      throw error
    }
  }

    /**
   * Build a complete transition graph by analyzing multiple issues
   * @param {number} sampleSize - Number of issues to analyze
   * @returns {Promise<Map>} Transition graph
   */
  async buildTransitionGraph(sampleSize = 50) {
    try {
      // Graph structure: Map<fromStatus, Map<toStatus, transitionId>>
      const transitionGraph = new Map()

      let jql = `order by created DESC`
      if (this.projectKey) {
        jql = `project = ${this.projectKey} AND ${jql}`
      }

      const response = await this.request('/search', {
        method: 'POST',
        body: JSON.stringify({
          jql,
          fields: ['key', 'status'],
          maxResults: sampleSize
        })
      })

      const data = await response.json()
      const issues = data.issues

      // For each issue, get available transitions
      for (const issue of issues) {
        const currentStatus = issue.fields.status.name
        const transitions = await this.getTransitions(issue.key)

        if (!transitionGraph.has(currentStatus)) {
          transitionGraph.set(currentStatus, new Map())
        }

        const statusTransitions = transitionGraph.get(currentStatus)

        for (const transition of transitions) {
          const toStatus = transition.to.name
          statusTransitions.set(toStatus, transition.id)
        }
      }

      return transitionGraph
    } catch (error) {
      console.error(`Error building transition graph:`, error.message)
      throw error
    }
  }

    /**
   * Find the shortest path of transitions between two statuses
   * @param {Map} transitionGraph - The complete transition graph
   * @param {string} fromStatus - Current status
   * @param {string} toStatus - Target status
   * @returns {Array} Array of transitions to perform
   */
  findTransitionPath(transitionGraph, fromStatus, toStatus) {
    if (fromStatus === toStatus) {
      return []
    }

    // BFS to find shortest path
    const queue = [[fromStatus, []]]
    const visited = new Set([fromStatus])

    while (queue.length > 0) {
      const [currentStatus, path] = queue.shift()

      if (!transitionGraph.has(currentStatus)) {
        continue
      }

      const transitions = transitionGraph.get(currentStatus)

      for (const [nextStatus, transitionId] of transitions) {
        if (nextStatus === toStatus) {
          return [...path, { from: currentStatus, to: nextStatus, id: transitionId }]
        }

        if (!visited.has(nextStatus)) {
          visited.add(nextStatus)
          queue.push([nextStatus, [...path, { from: currentStatus, to: nextStatus, id: transitionId }]])
        }
      }
    }

    return null
  }

  /**
   * Transition an issue through multiple states to reach target
   * @param {string} issueKey - Jira issue key
   * @param {string} targetStatus - Target status
   * @param {Map} transitionGraph - Pre-built transition graph (optional)
   */
  async transitionIssueSmart(issueKey, targetStatus, transitionGraph = null) {
    try {
      const issueResponse = await this.request(`/issue/${issueKey}?fields=status`)
      const issueData = await issueResponse.json()
      const currentStatus = issueData.fields.status.name

      if (currentStatus === targetStatus) {
        console.log(`Issue ${issueKey} is already in ${targetStatus} status`)
        return true
      }

      if (!transitionGraph) {
        console.log('Building transition graph...')
        transitionGraph = await this.buildTransitionGraph()
      }

      const path = this.findTransitionPath(transitionGraph, currentStatus, targetStatus)

      if (!path) {
        console.error(`No transition path found from ${currentStatus} to ${targetStatus}`)
        return false
      }

      console.log(`Found transition path: ${path.map(t => `${t.from} → ${t.to}`).join(' → ')}`)

      // Execute transitions in sequence
      for (const transition of path) {
        const availableTransitions = await this.getTransitions(issueKey)
        const actualTransition = availableTransitions.find(t => t.to.name === transition.to)

        if (!actualTransition) {
          console.error(`Transition to ${transition.to} not available for issue ${issueKey}`)
          return false
        }

        await this.request(`/issue/${issueKey}/transitions`, {
          method: 'POST',
          body: JSON.stringify({
            transition: {
              id: actualTransition.id
            }
          })
        })

        console.log(`Transitioned ${issueKey}: ${transition.from} → ${transition.to}`)

        // Small delay to ensure Jira processes the transition
        await new Promise(resolve => setTimeout(resolve, 500))
      }

      return true
    } catch (error) {
      console.error(`Error in smart transition for ${issueKey}:`, error.message)
      throw error
    }
  }
}

module.exports = Jira
