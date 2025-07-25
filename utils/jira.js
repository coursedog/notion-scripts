class Jira {
  constructor({ baseUrl, email, apiToken }) {
    this.baseUrl = baseUrl
    this.email = email
    this.apiToken = apiToken
    this.baseURL = `${baseUrl}/rest/api/3`
    this.stateMachine = null
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
   * Get complete workflow definition with all states and transitions
   * @param {string} workflowName - Name of the workflow
   * @returns {Promise<Object>} Complete workflow state machine
   */
  async getWorkflowStateMachine(workflowName) {
    if (this.stateMachine) {
      return this.stateMachine
    }

    try {
      const response = await this.request(`/workflow/search?workflowName=${encodeURIComponent(workflowName)}&expand=statuses,transitions`)
      const data = await response.json()

      if (!data.values || data.values.length === 0) {
        throw new Error(`Workflow "${workflowName}" not found`)
      }

      const workflow = data.values[0]

      // Build state machine structure
      const stateMachine = {
        name: workflow.id.name,
        states: {},
        transitions: [],
        transitionMap: new Map() // For quick lookup: Map<fromStatusId, Map<toStatusId, transition>>
      }

      // Process states
      if (workflow.statuses) {
        workflow.statuses.forEach(status => {
          stateMachine.states[status.id] = {
            id: status.id,
            name: status.name,
            statusCategory: status.statusCategory
          }
        })
      }

      // Process transitions
      if (workflow.transitions) {
        workflow.transitions.forEach(transition => {
          const transitionInfo = {
            id: transition.id,
            name: transition.name,
            from: transition.from || [],
            to: transition.to, // Target status ID
            type: transition.type || 'directed',
            hasScreen: transition.hasScreen || false,
            rules: transition.rules || {}
          }

          stateMachine.transitions.push(transitionInfo)

          const fromStatuses = transitionInfo.from.length > 0 ? transitionInfo.from : Object.keys(stateMachine.states)
          fromStatuses.forEach(fromStatus => {
            if (!stateMachine.transitionMap.has(fromStatus)) {
              stateMachine.transitionMap.set(fromStatus, new Map())
            }
            stateMachine.transitionMap.get(fromStatus).set(transitionInfo.to, transitionInfo)
          })
        })
      }

      this.stateMachine = stateMachine
      return stateMachine
    } catch (error) {
      console.error(`Error getting workflow state machine:`, error.message)
      throw error
    }
  }

  /**
   * Get all workflows in the system
   * @returns {Promise<Array>} List of all workflows
   */
  async getAllWorkflows() {
    try {
      const response = await this.request('/workflow/search')
      const data = await response.json()
      return data.values || []
    } catch (error) {
      console.error(`Error getting all workflows:`, error.message)
      throw error
    }
  }

  /**
   * Get workflow for a specific project and issue type
   * @param {string} projectKey - Project key
   * @param {string} issueTypeName - Issue type name (optional)
   * @returns {Promise<Object>} Workflow name
   */
  async getProjectWorkflowName(projectKey) {
    try {
      const projectResponse = await this.request(`/project/${projectKey}`)
      const project = await projectResponse.json()

      const workflowSchemeResponse = await this.request(`/workflowscheme/project?projectId=${project.id}`)
      const workflowScheme = await workflowSchemeResponse.json()

      if (!workflowScheme.values || workflowScheme.values.length === 0) {
        throw new Error(`No workflow scheme found for project ${projectKey}`)
      }

      const scheme = workflowScheme.values[0]
      return scheme.workflowScheme.defaultWorkflow
    } catch (error) {
      console.error(`Error getting project workflow:`, error.message)
      throw error
    }
  }

  /**
   * Find all possible paths between two statuses in a workflow
   * @param {Object} stateMachine - The workflow state machine
   * @param {string} fromStatusName - Starting status name
   * @param {string} toStatusName - Target status name
   * @returns {Array} All possible paths
   */
  findAllTransitionPaths(stateMachine, fromStatusName, toStatusName) {
    // Convert names to IDs
    let fromStatusId = null
    let toStatusId = null

    for (const [statusId, status] of Object.entries(stateMachine.states)) {
      if (status.name === fromStatusName) fromStatusId = statusId
      if (status.name === toStatusName) toStatusId = statusId
    }

    if (!fromStatusId || !toStatusId) {
      throw new Error(`Status not found: ${!fromStatusId ? fromStatusName : toStatusName}`)
    }

    if (fromStatusId === toStatusId) {
      return [[]] // Empty path - already at destination
    }

    const paths = []
    const visited = new Set()

    function dfs(currentId, path) {
      if (currentId === toStatusId) {
        paths.push([...path])
        return
      }

      visited.add(currentId)

      const transitions = stateMachine.transitionMap.get(currentId)
      if (transitions) {
        for (const [nextStatusId, transition] of transitions) {
          if (!visited.has(nextStatusId)) {
            path.push({
              id: transition.id,
              name: transition.name,
              from: currentId,
              to: nextStatusId,
              fromName: stateMachine.states[currentId].name,
              toName: stateMachine.states[nextStatusId].name
            })
            dfs(nextStatusId, path)
            path.pop()
          }
        }
      }

      visited.delete(currentId)
    }

    dfs(fromStatusId, [])
    return paths
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
   * Search for issues with a specific status and update them
   * @param {string} currentStatus - Current status to search for
   * @param {string} newStatus - New status to transition to
   */
  async updateByStatus(currentStatus, newStatus) {
    try {
      let jql = `status = "${currentStatus}"`
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
      let jql = `text ~ "${prUrl}"`
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
   * Find the shortest path between two statuses using BFS, excluding paths through certain states
   * @param {Object} stateMachine - The workflow state machine
   * @param {string} fromStatusName - Starting status name
   * @param {string} toStatusName - Target status name
   * @param {Array<string>} excludeStates - Array of state names to exclude from paths (optional)
   * @returns {Array} Shortest path of transitions
   */
  findShortestTransitionPath(stateMachine, fromStatusName, toStatusName, excludeStates = []) {
    // Convert names to IDs
    let fromStatusId = null
    let toStatusId = null
    const excludeStatusIds = new Set()

    for (const [statusId, status] of Object.entries(stateMachine.states)) {
      if (status.name === fromStatusName) fromStatusId = statusId
      if (status.name === toStatusName) toStatusId = statusId
      if (excludeStates.includes(status.name)) {
        excludeStatusIds.add(statusId)
      }
    }

    if (!fromStatusId || !toStatusId) {
      throw new Error(`Status not found: ${!fromStatusId ? fromStatusName : toStatusName}`)
    }

    if (fromStatusId === toStatusId) {
      return [] // Already at destination
    }

    // Check if target status is in excluded states
    if (excludeStatusIds.has(toStatusId)) {
      console.warn(`Target status "${toStatusName}" is in the excluded states list`)
      return null
    }

    // BFS to find shortest path
    const queue = [{ statusId: fromStatusId, path: [] }]
    const visited = new Set([fromStatusId])

    while (queue.length > 0) {
      const { statusId: currentId, path } = queue.shift()

      const transitions = stateMachine.transitionMap.get(currentId)
      if (transitions) {
        for (const [nextStatusId, transition] of transitions) {
          // Skip if the next status is in the excluded list (unless it's the target)
          if (excludeStatusIds.has(nextStatusId) && nextStatusId !== toStatusId) {
            continue
          }

          if (nextStatusId === toStatusId) {
            // Found the target
            return [...path, {
              id: transition.id,
              name: transition.name,
              from: currentId,
              to: nextStatusId,
              fromName: stateMachine.states[currentId].name,
              toName: stateMachine.states[nextStatusId].name
            }]
          }

          if (!visited.has(nextStatusId)) {
            visited.add(nextStatusId)
            queue.push({
              statusId: nextStatusId,
              path: [...path, {
                id: transition.id,
                name: transition.name,
                from: currentId,
                to: nextStatusId,
                fromName: stateMachine.states[currentId].name,
                toName: stateMachine.states[nextStatusId].name
              }]
            })
          }
        }
      }
    }

    return null
  }

  /**
   * Transition an issue through multiple states to reach target
   * @param {string} issueKey - Jira issue key
   * @param {string} targetStatus - Target status name
   * @param {Array<string>} excludeStates - Array of state names to exclude from paths (optional)
   */
  async transitionIssue(issueKey, targetStatusName, excludeStates = ['Blocked', 'Rejected']) {
    try {
      // Get current issue status
      const issueResponse = await this.request(`/issue/${issueKey}?fields=status`)
      const issueData = await issueResponse.json()
      const currentStatusName = issueData.fields.status.name

      if (currentStatusName === targetStatusName) {
        console.log(`Issue ${issueKey} is already in ${targetStatusName} status`)
        return true
      }

      const [projectKey] = issueKey.split('-')
      const workflowName = await this.getProjectWorkflowName(projectKey)
      const stateMachine = await this.getWorkflowStateMachine(workflowName)

      // Find shortest path using BFS, excluding specified states
      const shortestPath = this.findShortestTransitionPath(
        stateMachine,
        currentStatusName,
        targetStatusName,
        excludeStates
      )

      if (!shortestPath) {
        console.error(`No transition path found from ${currentStatusName} to ${targetStatusName} that avoids ${excludeStates.join(', ')}`)
        return false
      }

      console.log(`Found shortest transition path with ${shortestPath.length} steps:`)
      shortestPath.forEach(t => console.log(`  ${t.fromName} → ${t.toName} (${t.name})`))

      // Execute transitions in sequence
      for (const transition of shortestPath) {
        // Get available transitions for current state of the issue
        const availableTransitions = await this.getTransitions(issueKey)

        // Find the matching transition
        const actualTransition = availableTransitions.find(t =>
          t.id === transition.id ||
          (t.to.name === transition.toName && t.name === transition.name)
        )

        if (!actualTransition) {
          console.error(`Transition "${transition.name}" to ${transition.toName} not available for issue ${issueKey}`)
          console.error(`Available transitions:`, availableTransitions.map(t => `${t.name} → ${t.to.name}`))
          return false
        }

        // Execute the transition
        await this.request(`/issue/${issueKey}/transitions`, {
          method: 'POST',
          body: JSON.stringify({
            transition: {
              id: actualTransition.id
            }
          })
        })

        console.log(`✓ Transitioned ${issueKey}: ${transition.fromName} → ${transition.toName}`)

        // Small delay to ensure Jira processes the transition
        await new Promise(resolve => setTimeout(resolve, 500))
      }

      console.log(`Successfully transitioned ${issueKey} to ${targetStatusName}`)
      return true

    } catch (error) {
      console.error(`Error in smart transition for ${issueKey}:`, error.message)
      throw error
    }
  }
}

module.exports = Jira
