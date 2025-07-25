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
   * Get complete workflow definition with all states and transitions
   * @param {string} workflowName - Name of the workflow
   * @returns {Promise<Object>} Complete workflow state machine
   */
  async getWorkflowStateMachine(workflowName) {
    try {
      const response = await this.request(`/workflow/search?workflowName=${encodeURIComponent(workflowName)}&expand=statuses,transitions`)
      const data = await response.json()

      console.log('GOT DATA', data)

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
   * Print workflow state machine in a readable format
   * @param {Object} stateMachine - The workflow state machine
   */
  printStateMachine(stateMachine) {
    console.log(`\n=== WORKFLOW: ${stateMachine.name} ===`)

    console.log('\n--- STATES ---')
    console.log(JSON.stringify(stateMachine), '\n\n\n', 'AAAAAAAAAAAAAAAAA')
    for (const [id, state] of Object.entries(stateMachine.states)) {
      console.log(`  [${id}] ${state.name} (${state.statusCategory.name})`)
    }

    console.log('\n--- TRANSITIONS ---')
    for (const transition of stateMachine.transitions) {
      const fromStates = transition.from.length > 0
        ? transition.from.map(id => stateMachine.states[id]?.name || id).join(', ')
        : 'ANY'
      const toState = stateMachine.states[transition.to]?.name || transition.to

      console.log(`  [${transition.id}] "${transition.name}": ${fromStates} → ${toState}`)
      if (transition.hasScreen) {
        console.log(`    (Has screen)`)
      }
    }

    console.log('\n--- TRANSITION PATHS ---')
    // Show example paths between common states
    const commonPairs = [
      ['To Do', 'Done'],
      ['In Progress', 'To Do'],
      ['Done', 'In Progress']
    ]

    for (const [from, to] of commonPairs) {
      try {
        const paths = this.findAllTransitionPaths(stateMachine, from, to)
        if (paths.length > 0) {
          console.log(`\n  ${from} → ${to}: ${paths.length} path(s) found`)
          paths.forEach((path, index) => {
            if (path.length === 0) {
              console.log(`    Path ${index + 1}: Already at destination`)
            } else {
              const pathStr = path.map(t => t.name).join(' → ')
              console.log(`    Path ${index + 1}: ${pathStr}`)
            }
          })
        }
      } catch (e) {
        // Skip if states don't exist
      }
    }
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
