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

      const stateMachine = {
        name: workflow.id.name,
        states: {},
        transitions: [],
        transitionMap: new Map() // For quick lookup: Map<fromStatusId, Map<toStatusId, transition>>
      }

      if (workflow.statuses) {
        workflow.statuses.forEach(status => {
          stateMachine.states[status.id] = {
            id: status.id,
            name: status.name,
            statusCategory: status.statusCategory
          }
        })
      }

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
   * @param {Object} fields - Additional fields to set during transition
   */
  async updateByStatus(currentStatus, newStatus, fields = {}) {
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

      const settledIssuePromises = await Promise.allSettled(
        issues.map((issue) => this.transitionIssue(
          issue.key,
          newStatus,
          ['Blocked', 'Rejected'],
          fields
        ))
      )

      const rejected = settledIssuePromises.filter((result) => result.status === 'rejected')
      const fullfilled = settledIssuePromises.filter((result) => result.status === 'fulfilled')

      console.log(`Sucessfully updated ${fullfilled.length} isssues.`)

      if (rejected) {
        console.log(`Failed to update ${rejected.length} isssues.`)
      }

      return issues
    } catch (error) {
      console.error(`Error updating issues by status:`, error.message)
      throw error
    }
  }

  /**
   * Find issues that mention a PR URL and update their status
   * @param {string} prUrl - PR URL to search for (e.g., "myrepo/pull/123")
   * @param {string} newStatus - New status to transition to
   * @param {Object} fields - Additional fields to set during transition
   */
  async updateByPR(prUrl, newStatus, fields = {}) {
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
        await this.transitionIssue(issue.key, newStatus, ['Blocked', 'Rejected'], fields)
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
      const project = await this.request(`/project/${projectKey}`)
      const projectData = await project.json()

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
   * Update custom field on an issue
   * @param {string} issueKey - Jira issue key
   * @param {string} customFieldId - Custom field ID (e.g., 'customfield_10001')
   * @param {any} value - Value to set for the custom field
   * @returns {Promise<boolean>} Success status
   */
  async updateCustomField(issueKey, customFieldId, value) {
    try {
      const updatePayload = {
        fields: {
          [customFieldId]: value
        }
      }

      await this.request(`/issue/${issueKey}`, {
        method: 'PUT',
        body: JSON.stringify(updatePayload)
      })

      console.log(`✓ Updated custom field ${customFieldId} for issue ${issueKey}`)
      return true
    } catch (error) {
      console.error(`Error updating custom field ${customFieldId} for ${issueKey}:`, error.message)
      throw error
    }
  }

  /**
   * Update multiple custom fields on an issue
   * @param {string} issueKey - Jira issue key
   * @param {Object} customFields - Object with custom field IDs as keys and values as values
   * @returns {Promise<boolean>} Success status
   */
  async updateCustomFields(issueKey, customFields) {
    try {
      const updatePayload = {
        fields: customFields
      }

      await this.request(`/issue/${issueKey}`, {
        method: 'PUT',
        body: JSON.stringify(updatePayload)
      })

      console.log(`✓ Updated ${Object.keys(customFields).length} custom fields for issue ${issueKey}`)
      return true
    } catch (error) {
      console.error(`Error updating custom fields for ${issueKey}:`, error.message)
      throw error
    }
  }

  /**
   * Get custom field value from an issue
   * @param {string} issueKey - Jira issue key
   * @param {string} customFieldId - Custom field ID (e.g., 'customfield_10001')
   * @returns {Promise<any>} Custom field value
   */
  async getCustomField(issueKey, customFieldId) {
    try {
      const response = await this.request(`/issue/${issueKey}?fields=${customFieldId}`)
      const issueData = await response.json()
      return issueData.fields[customFieldId]
    } catch (error) {
      console.error(`Error getting custom field ${customFieldId} for ${issueKey}:`, error.message)
      throw error
    }
  }

  /**
   * Generic method to get field values by type
   * @param {string} fieldName - Field name (resolution, priority, etc)
   * @returns {Promise<Array>} Available options for the field
   */
  async getFieldOptions(fieldName) {
    try {
      const fieldMappings = {
        'resolution': '/resolution',
        'priority': '/priority',
        'issuetype': '/issuetype',
        'component': '/component',
        'version': '/version'
      }

      const endpoint = fieldMappings[fieldName]
      if (!endpoint) {
        console.log(`No endpoint mapping for field: ${fieldName}`)
        return []
      }

      const response = await this.request(endpoint)
      const options = await response.json()
      return options
    } catch (error) {
      console.error(`Error getting ${fieldName} options:`, error.message)
      return []
    }
  }

  /**
   * Get transition details including required fields
   * @param {string} issueKey - Jira issue key
   * @param {string} transitionId - Transition ID
   * @returns {Promise<Object>} Transition details
   */
  async getTransitionDetails(issueKey, transitionId) {
    try {
      const response = await this.request(`/issue/${issueKey}/transitions?transitionId=${transitionId}&expand=transitions.fields`)
      const data = await response.json()
      const transition = data.transitions.find(t => t.id === transitionId)
      return transition || {}
    } catch (error) {
      console.error(`Error getting transition details:`, error.message)
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
   * @param {Object} fields - Additional fields to set during the final transition
   */
  async transitionIssue(issueKey, targetStatusName, excludeStates = ['Blocked', 'Rejected'], fields = {}) {
    try {
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

      for (let i = 0; i < shortestPath.length; i++) {
        const transition = shortestPath[i]
        const isLastTransition = i === shortestPath.length - 1
        const availableTransitions = await this.getTransitions(issueKey)

        const actualTransition = availableTransitions.find(t =>
          t.id === transition.id ||
          (t.to.name === transition.toName && t.name === transition.name)
        )

        if (!actualTransition) {
          console.error(`Transition "${transition.name}" to ${transition.toName} not available for issue ${issueKey}`)
          console.error(`Available transitions:`, availableTransitions.map(t => `${t.name} → ${t.to.name}`))
          return false
        }

        const transitionPayload = {
          transition: {
            id: actualTransition.id
          }
        }

        if (isLastTransition && Object.keys(fields).length > 0) {
          transitionPayload.fields = fields
        }

        const transitionDetails = await this.getTransitionDetails(issueKey, actualTransition.id)
        if (transitionDetails.fields) {
          for (const [fieldId, fieldInfo] of Object.entries(transitionDetails.fields)) {
            if (fieldInfo.required && !transitionPayload.fields?.[fieldId]) {
              console.warn(`Required field ${fieldId} (${fieldInfo.name}) not provided for transition to ${transition.toName}`)
            }
          }
        }

        await this.request(`/issue/${issueKey}/transitions`, {
          method: 'POST',
          body: JSON.stringify(transitionPayload)
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
