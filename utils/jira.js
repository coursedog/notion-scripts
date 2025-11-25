/**
 * @fileoverview Jira API Integration Utility
 * @module utils/jira
 * @version 2.0.0
 */

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

/**
 * Jira API and operational constants
 * @const {Object}
 */
const JIRA_CONSTANTS = {
  API_VERSION: 3,

  MAX_RESULTS: {
    DEFAULT: 100,
    SEARCH: 50,
    COMMIT_HISTORY: 20,
  },

  DELAYS: {
    TRANSITION_MS: 500,      // Delay between transitions to allow Jira to process
    RETRY_BASE_MS: 1000,     // Base delay for retry backoff
    RATE_LIMIT_DEFAULT_S: 60, // Default wait time for rate limiting
  },

  RETRY: {
    MAX_ATTEMPTS: 3,
    BACKOFF_MULTIPLIER: 2,
  },

  VALIDATION: {
    ISSUE_KEY_PATTERN: /^[A-Z][A-Z0-9]+-\d+$/,
    ISSUE_KEY_EXTRACT_PATTERN: /[A-Z]+-[0-9]+/g,
    MAX_PATH_DEPTH: 10,
  },

  FIELD_MAPPINGS: {
    resolution: '/resolution',
    priority: '/priority',
    issuetype: '/issuetype',
    component: '/component',
    version: '/version',
  },

  HTTP_STATUS: {
    OK: 200,
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    TOO_MANY_REQUESTS: 429,
    INTERNAL_SERVER_ERROR: 500,
  },

  DEFAULT_EXCLUDE_STATES: [ 'Blocked', 'Rejected' ],

  UNRESOLVED_RESOLUTION_ID: '-1',
}

// ============================================================================
// CUSTOM ERROR CLASSES
// ============================================================================

/**
 * Base error class for all Jira-related errors
 * @extends Error
 */
class JiraError extends Error {
  /**
   * @param {string} message - Error message
   * @param {Object} [context={}] - Additional error context
   */
  constructor (message, context = {}) {
    super(message)
    this.name = this.constructor.name
    this.context = context
    this.timestamp = new Date().toISOString()
    Error.captureStackTrace(this, this.constructor)
  }
}

/**
 * Thrown when Jira API returns an error response
 * @extends JiraError
 */
class JiraApiError extends JiraError {
  /**
   * @param {string} message - Error message
   * @param {number} statusCode - HTTP status code
   * @param {string} endpoint - API endpoint that failed
   * @param {string} [responseBody] - Raw response body from Jira
   */
  constructor (message, statusCode, endpoint, responseBody) {
    super(message, { statusCode, endpoint, responseBody })
    this.statusCode = statusCode
    this.endpoint = endpoint
    this.responseBody = responseBody
  }
}

/**
 * Thrown when issue transition fails
 * @extends JiraError
 */
class JiraTransitionError extends JiraError {
  /**
   * @param {string} message - Error message
   * @param {string} issueKey - Issue key that failed to transition
   * @param {string} fromStatus - Current status
   * @param {string} toStatus - Target status
   * @param {string} [reason] - Detailed reason for failure
   */
  constructor (message, issueKey, fromStatus, toStatus, reason) {
    super(message, { issueKey, fromStatus, toStatus, reason })
    this.issueKey = issueKey
    this.fromStatus = fromStatus
    this.toStatus = toStatus
    this.reason = reason
  }
}

/**
 * Thrown when input validation fails
 * @extends JiraError
 */
class JiraValidationError extends JiraError {
  /**
   * @param {string} message - Error message
   * @param {string} field - Field that failed validation
   * @param {*} value - Invalid value
   */
  constructor (message, field, value) {
    super(message, { field, value })
    this.field = field
    this.value = value
  }
}

/**
 * Thrown when workflow configuration is invalid or missing
 * @extends JiraError
 */
class JiraWorkflowError extends JiraError {
  /**
   * @param {string} message - Error message
   * @param {string} workflowName - Workflow name
   * @param {string} [projectKey] - Project key
   */
  constructor (message, workflowName, projectKey) {
    super(message, { workflowName, projectKey })
    this.workflowName = workflowName
    this.projectKey = projectKey
  }
}

// ============================================================================
// LOGGING SYSTEM
// ============================================================================

/**
 * Log levels enumeration
 * @enum {string}
 */
const LogLevel = {
  DEBUG: 'DEBUG',
  INFO: 'INFO',
  WARN: 'WARN',
  ERROR: 'ERROR',
}

/**
 * Logger with context support and multiple log levels
 * @class Logger
 */
class Logger {
  /**
   * @param {string} [context='Jira'] - Logger context/namespace
   * @param {string} [level='INFO'] - Minimum log level to output
   */
  constructor (context = 'Jira', level = 'INFO') {
    this.context = context
    this.level = level
    this.levelPriority = {
      DEBUG: 0,
      INFO: 1,
      WARN: 2,
      ERROR: 3,
    }
  }

  /**
   * Check if a log level should be output
   * @private
   * @param {string} level - Log level to check
   * @returns {boolean} True if should log
   */
  _shouldLog (level) {
    return this.levelPriority[level] >= this.levelPriority[this.level]
  }

  /**
   * Format and output log message
   * @private
   * @param {string} level - Log level
   * @param {string} message - Log message
   * @param {Object} [data={}] - Additional structured data
   */
  _log (level, message, data = {}) {
    if (!this._shouldLog(level)) return

    const timestamp = new Date().toISOString()
    const logFn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log

    // Structured logging for better parsing
    if (Object.keys(data).length > 0) {
      logFn(`[${timestamp}] [${level}] [${this.context}] ${message}`, JSON.stringify(data, null, 2))
    } else {
      logFn(`[${timestamp}] [${level}] [${this.context}] ${message}`)
    }
  }

  /**
   * Mask sensitive data in logs
   * @private
   * @param {Object} data - Data to mask
   * @returns {Object} Masked data
   */
  _maskSensitiveData (data) {
    if (!data || typeof data !== 'object') return data

    const masked = { ...data }
    const sensitiveFields = [ 'apiToken', 'token', 'password', 'secret', 'authorization', 'Authorization' ]

    for (const field of sensitiveFields) {
      if (masked[field]) {
        masked[field] = '***REDACTED***'
      }
    }

    // Mask nested objects
    if (masked.headers && masked.headers.Authorization) {
      masked.headers.Authorization = '***REDACTED***'
    }

    return masked
  }

  /**
   * Log debug message (detailed diagnostic information)
   * @param {string} message - Log message
   * @param {Object} [data={}] - Additional data
   */
  debug (message, data = {}) {
    this._log(LogLevel.DEBUG, message, data)
  }

  /**
   * Log info message (general information about operations)
   * @param {string} message - Log message
   * @param {Object} [data={}] - Additional data
   */
  info (message, data = {}) {
    this._log(LogLevel.INFO, message, data)
  }

  /**
   * Log warning message (potentially problematic situations)
   * @param {string} message - Log message
   * @param {Object} [data={}] - Additional data
   */
  warn (message, data = {}) {
    this._log(LogLevel.WARN, message, data)
  }

  /**
   * Log error message (error events that might still allow the application to continue)
   * @param {string} message - Log message
   * @param {Error|Object} [error={}] - Error object or additional data
   */
  error (message, error = {}) {
    const errorData = error instanceof Error
      ? {
        name: error.name,
        message: error.message,
        stack: error.stack,
        ...(error.context || {}),
      }
      : error

    this._log(LogLevel.ERROR, message, errorData)
  }

  /**
   * Log operation start with timing
   * @param {string} operation - Operation name
   * @param {Object} [params={}] - Operation parameters
   * @returns {Function} Function to call when operation completes
   */
  startOperation (operation, params = {}) {
    const startTime = Date.now()
    const operationId = `${operation}_${startTime}`

    this.info(`Operation started: ${operation}`, { operationId, params })

    return (status = 'success', result = {}) => {
      const duration = Date.now() - startTime
      this.info(`Operation completed: ${operation}`, {
        operationId,
        status,
        durationMs: duration,
        result,
      })
    }
  }

  /**
   * Create child logger with additional context
   * @param {string} subContext - Additional context to append
   * @returns {Logger} New logger instance
   */
  child (subContext) {
    return new Logger(`${this.context}:${subContext}`, this.level)
  }
}

// ============================================================================
// JIRA API CLIENT
// ============================================================================

/**
 * Jira API Client
 * @class Jira
 */
class Jira {
  /**
   * @param {Object} config - Configuration object
   * @param {string} config.baseUrl - Jira instance base URL
   * @param {string} config.email - Email for authentication
   * @param {string} config.apiToken - API token for authentication
   * @param {string} [config.logLevel='INFO'] - Logging level (DEBUG, INFO, WARN, ERROR)
   * @throws {JiraValidationError} If required configuration is missing
   */
  constructor ({ baseUrl, email, apiToken, logLevel = 'INFO' }) {
    this.logger = new Logger('Jira', logLevel)

    // Validate required configuration
    this._validateConfig({ baseUrl, email, apiToken })

    this.baseUrl = baseUrl
    this.email = email
    this.apiToken = apiToken
    this.baseURL = `${baseUrl}/rest/api/${JIRA_CONSTANTS.API_VERSION}`

    // Per-project state machine cache: Map<workflowName, stateMachine>
    this.stateMachineCache = new Map()

    // Setup authentication headers
    this.headers = {
      'Authorization': `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    }

    this.logger.info('Jira client initialized', {
      baseUrl,
      email: this._maskEmail(email),
      apiVersion: JIRA_CONSTANTS.API_VERSION,
    })
  }

  // ==========================================================================
  // PRIVATE UTILITY METHODS
  // ==========================================================================

  /**
   * Validate configuration object
   * @private
   * @param {Object} config - Configuration to validate
   * @throws {JiraValidationError} If validation fails
   */
  _validateConfig (config) {
    const required = [ 'baseUrl', 'email', 'apiToken' ]

    for (const field of required) {
      if (!config[field] || typeof config[field] !== 'string') {
        throw new JiraValidationError(
          `Missing or invalid required configuration: ${field}`,
          field,
          config[field]
        )
      }
    }

    // Validate URL format
    try {
      new URL(config.baseUrl)
    } catch (error) {
      throw new JiraValidationError(
        `Invalid baseUrl format: ${config.baseUrl}`,
        'baseUrl',
        config.baseUrl
      )
    }

    // Validate email format
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.email)) {
      throw new JiraValidationError(
        `Invalid email format: ${config.email}`,
        'email',
        config.email
      )
    }
  }

  /**
   * Validate and normalize Jira issue key
   * @private
   * @param {string} issueKey - Issue key to validate
   * @returns {string} Normalized issue key
   * @throws {JiraValidationError} If validation fails
   */
  _validateIssueKey (issueKey) {
    if (!issueKey || typeof issueKey !== 'string') {
      throw new JiraValidationError(
        'Issue key must be a non-empty string',
        'issueKey',
        issueKey
      )
    }

    const normalized = issueKey.trim().toUpperCase()

    if (!JIRA_CONSTANTS.VALIDATION.ISSUE_KEY_PATTERN.test(normalized)) {
      throw new JiraValidationError(
        `Invalid issue key format: ${issueKey}. Expected format: PROJECT-123`,
        'issueKey',
        issueKey
      )
    }

    return normalized
  }

  /**
   * Mask email for logging
   * @private
   * @param {string} email - Email to mask
   * @returns {string} Masked email
   */
  _maskEmail (email) {
    const [ user, domain ] = email.split('@')
    return `${user.substring(0, 2)}***@${domain}`
  }

  /**
   * Sleep for specified milliseconds
   * @private
   * @param {number} ms - Milliseconds to sleep
   * @returns {Promise<void>}
   */
  _sleep (ms) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Extract project key from issue key
   * @private
   * @param {string} issueKey - Issue key (e.g., 'DCX-2117')
   * @returns {string} Project key (e.g., 'DCX')
   */
  _extractProjectKey (issueKey) {
    const [ projectKey ] = issueKey.split('-')
    return projectKey
  }

  // ==========================================================================
  // HTTP REQUEST METHODS
  // ==========================================================================

  /**
   * Make an authenticated request to Jira API with retry logic and rate limiting
   * @private
   * @param {string} endpoint - API endpoint
   * @param {Object} [options={}] - Fetch options
   * @param {number} [retryCount=0] - Current retry attempt
   * @returns {Promise<Response>} Fetch Response object
   * @throws {JiraApiError} If request fails after all retries
   */
  async request (endpoint, options = {}, retryCount = 0) {
    const url = `${this.baseURL}${endpoint}`
    const method = options.method || 'GET'

    this.logger.debug(`API Request: ${method} ${endpoint}`, {
      url,
      method,
      retryCount,
      hasBody: !!options.body,
    })

    try {
      const response = await fetch(url, {
        ...options,
        headers: {
          ...this.headers,
          ...options.headers,
        },
      })

      this.logger.debug(`API Response: ${method} ${endpoint}`, {
        status: response.status,
        statusText: response.statusText,
      })

      // Handle rate limiting (429 Too Many Requests)
      if (response.status === JIRA_CONSTANTS.HTTP_STATUS.TOO_MANY_REQUESTS) {
        const retryAfter = response.headers.get('Retry-After') || JIRA_CONSTANTS.DELAYS.RATE_LIMIT_DEFAULT_S
        this.logger.warn(`Rate limited by Jira API`, {
          endpoint,
          retryAfterSeconds: retryAfter,
          retryCount,
        })

        if (retryCount < JIRA_CONSTANTS.RETRY.MAX_ATTEMPTS) {
          await this._sleep(retryAfter * 1000)
          return this.request(endpoint, options, retryCount + 1)
        }
      }

      // Handle non-OK responses
      if (!response.ok) {
        const errorText = await response.text()

        this.logger.error(`API request failed: ${method} ${endpoint}`, {
          status: response.status,
          statusText: response.statusText,
          errorBody: errorText,
          retryCount,
        })

        // Retry on server errors (5xx)
        if (
          response.status >= JIRA_CONSTANTS.HTTP_STATUS.INTERNAL_SERVER_ERROR &&
          retryCount < JIRA_CONSTANTS.RETRY.MAX_ATTEMPTS
        ) {
          const delay = JIRA_CONSTANTS.DELAYS.RETRY_BASE_MS *
            Math.pow(JIRA_CONSTANTS.RETRY.BACKOFF_MULTIPLIER, retryCount)

          this.logger.warn(`Retrying failed request after ${delay}ms`, {
            endpoint,
            attempt: retryCount + 1,
            maxAttempts: JIRA_CONSTANTS.RETRY.MAX_ATTEMPTS,
          })

          await this._sleep(delay)
          return this.request(endpoint, options, retryCount + 1)
        }

        throw new JiraApiError(
          `Jira API error: ${response.status} ${response.statusText}`,
          response.status,
          endpoint,
          errorText
        )
      }

      return response
    } catch (error) {
      // Re-throw JiraApiError as-is
      if (error instanceof JiraApiError) {
        throw error
      }

      // Retry on network errors
      if (retryCount < JIRA_CONSTANTS.RETRY.MAX_ATTEMPTS) {
        const delay = JIRA_CONSTANTS.DELAYS.RETRY_BASE_MS *
          Math.pow(JIRA_CONSTANTS.RETRY.BACKOFF_MULTIPLIER, retryCount)

        this.logger.warn(`Network error, retrying after ${delay}ms`, {
          endpoint,
          error: error.message,
          attempt: retryCount + 1,
        })

        await this._sleep(delay)
        return this.request(endpoint, options, retryCount + 1)
      }

      this.logger.error(`Request failed after ${retryCount} retries`, {
        endpoint,
        error: error.message,
      })

      throw new JiraApiError(
        `Network error: ${error.message}`,
        0,
        endpoint,
        error.stack
      )
    }
  }

  // ==========================================================================
  // WORKFLOW & STATE MACHINE METHODS
  // ==========================================================================

  /**
   * Get complete workflow definition with all states and transitions
   * @param {string} workflowName - Name of the workflow
   * @returns {Promise<Object>} Complete workflow state machine
   * @throws {JiraWorkflowError} If workflow is not found
   * @throws {JiraApiError} If API request fails
   */
  async getWorkflowStateMachine (workflowName) {
    const logger = this.logger.child('getWorkflowStateMachine')
    const endOp = logger.startOperation('getWorkflowStateMachine', { workflowName })

    try {
      // Validate input
      if (!workflowName || typeof workflowName !== 'string') {
        throw new JiraValidationError(
          'Workflow name must be a non-empty string',
          'workflowName',
          workflowName
        )
      }

      // Check cache first
      if (this.stateMachineCache.has(workflowName)) {
        logger.debug(`Retrieved workflow from cache`, { workflowName })
        endOp('success', { source: 'cache' })
        return this.stateMachineCache.get(workflowName)
      }

      logger.info(`Fetching workflow state machine`, { workflowName })

      const response = await this.request(
        `/workflow/search?workflowName=${encodeURIComponent(workflowName)}&expand=statuses,transitions`
      )
      const data = await response.json()

      if (!data.values || data.values.length === 0) {
        throw new JiraWorkflowError(
          `Workflow "${workflowName}" not found`,
          workflowName
        )
      }

      const workflow = data.values[0]

      const stateMachine = {
        name: workflow.id.name,
        states: {},
        transitions: [],
        transitionMap: new Map(), // Map<fromStatusId, Map<toStatusId, transition>>
      }

      // Build states map
      if (workflow.statuses) {
        workflow.statuses.forEach((status) => {
          stateMachine.states[status.id] = {
            id: status.id,
            name: status.name,
            statusCategory: status.statusCategory,
          }
        })

        logger.debug(`Loaded ${workflow.statuses.length} statuses`, {
          workflowName,
          statuses: workflow.statuses.map(s => s.name),
        })
      }

      // Build transitions array and map
      if (workflow.transitions) {
        workflow.transitions.forEach((transition) => {
          const transitionInfo = {
            id: transition.id,
            name: transition.name,
            from: transition.from || [],
            to: transition.to,
            type: transition.type || 'directed',
            hasScreen: transition.hasScreen || false,
            rules: transition.rules || {},
          }

          stateMachine.transitions.push(transitionInfo)

          // Build transition map for quick lookup
          const fromStatuses = transitionInfo.from.length > 0
            ? transitionInfo.from
            : Object.keys(stateMachine.states)

          fromStatuses.forEach((fromStatus) => {
            if (!stateMachine.transitionMap.has(fromStatus)) {
              stateMachine.transitionMap.set(fromStatus, new Map())
            }
            stateMachine.transitionMap.get(fromStatus).set(transitionInfo.to, transitionInfo)
          })
        })

        logger.debug(`Loaded ${workflow.transitions.length} transitions`, {
          workflowName,
          transitions: workflow.transitions.map(t => t.name),
        })
      }

      // Cache the result
      this.stateMachineCache.set(workflowName, stateMachine)

      logger.info(`Successfully loaded workflow state machine`, {
        workflowName,
        statusCount: Object.keys(stateMachine.states).length,
        transitionCount: stateMachine.transitions.length,
      })

      endOp('success', {
        statusCount: Object.keys(stateMachine.states).length,
        transitionCount: stateMachine.transitions.length,
      })

      return stateMachine
    } catch (error) {
      logger.error(`Failed to get workflow state machine`, error)
      endOp('failure', { error: error.message })
      throw error
    }
  }

  /**
   * Get all workflows in the Jira system
   * @returns {Promise<Array<Object>>} List of all workflows
   * @throws {JiraApiError} If API request fails
   */
  async getAllWorkflows () {
    const logger = this.logger.child('getAllWorkflows')
    const endOp = logger.startOperation('getAllWorkflows')

    try {
      logger.info('Fetching all workflows')

      const response = await this.request('/workflow/search')
      const data = await response.json()
      const workflows = data.values || []

      logger.info(`Retrieved ${workflows.length} workflows`, {
        workflows: workflows.map(w => w.id?.name || w.name),
      })

      endOp('success', { count: workflows.length })
      return workflows
    } catch (error) {
      logger.error('Failed to get all workflows', error)
      endOp('failure', { error: error.message })
      throw error
    }
  }

  /**
   * Get workflow name for a specific project
   * @param {string} projectKey - Project key
   * @returns {Promise<string>} Workflow name
   * @throws {JiraValidationError} If projectKey is invalid
   * @throws {JiraWorkflowError} If no workflow scheme found
   * @throws {JiraApiError} If API request fails
   */
  async getProjectWorkflowName (projectKey) {
    const logger = this.logger.child('getProjectWorkflowName')
    const endOp = logger.startOperation('getProjectWorkflowName', { projectKey })

    try {
      // Validate input
      if (!projectKey || typeof projectKey !== 'string') {
        throw new JiraValidationError(
          'Project key must be a non-empty string',
          'projectKey',
          projectKey
        )
      }

      const normalizedKey = projectKey.trim().toUpperCase()

      logger.info(`Fetching workflow for project`, { projectKey: normalizedKey })

      // Get project details
      const projectResponse = await this.request(`/project/${normalizedKey}`)
      const project = await projectResponse.json()

      logger.debug(`Retrieved project details`, {
        projectKey: normalizedKey,
        projectId: project.id,
        projectName: project.name,
      })

      // Get workflow scheme for project
      const workflowSchemeResponse = await this.request(
        `/workflowscheme/project?projectId=${project.id}`
      )
      const workflowScheme = await workflowSchemeResponse.json()

      if (!workflowScheme.values || workflowScheme.values.length === 0) {
        throw new JiraWorkflowError(
          `No workflow scheme found for project ${normalizedKey}`,
          null,
          normalizedKey
        )
      }

      const scheme = workflowScheme.values[0]
      const workflowName = scheme.workflowScheme.defaultWorkflow

      logger.info(`Retrieved workflow for project`, {
        projectKey: normalizedKey,
        workflowName,
        schemeName: scheme.workflowScheme.name,
      })

      endOp('success', { workflowName })
      return workflowName
    } catch (error) {
      logger.error(`Failed to get project workflow`, error)
      endOp('failure', { error: error.message })
      throw error
    }
  }

  /**
   * Get workflow schema details for a project
   *
   * @param {string} projectKey - Jira project key
   * @returns {Promise<Object>} Workflow schema information
   *
   * @throws {JiraValidationError} If projectKey is invalid
   * @throws {JiraApiError} If API request fails
   */
  async getWorkflowSchema (projectKey) {
    const logger = this.logger.child('getWorkflowSchema')
    const endOp = logger.startOperation('getWorkflowSchema', { projectKey })

    try {
      if (!projectKey || typeof projectKey !== 'string') {
        throw new JiraValidationError(
          'Project key must be a non-empty string',
          'projectKey',
          projectKey
        )
      }

      const normalizedKey = projectKey.trim().toUpperCase()

      logger.info(`Fetching workflow schema`, { projectKey: normalizedKey })

      const project = await this.request(`/project/${normalizedKey}`)
      const projectData = await project.json()

      const workflowResponse = await this.request(
        `/workflowscheme/project?projectId=${projectData.id}`
      )
      const workflowData = await workflowResponse.json()

      logger.info(`Retrieved workflow schema`, {
        projectKey: normalizedKey,
        schemeCount: workflowData.values?.length || 0,
      })

      endOp('success')
      return workflowData
    } catch (error) {
      logger.error(`Failed to get workflow schema`, error)
      endOp('failure', { error: error.message })
      throw error
    }
  }

  /**
   * Get all available statuses in Jira
   *
   * @returns {Promise<Array<Object>>} All available statuses
   * @returns {string} return[].id - Status ID
   * @returns {string} return[].name - Status name
   * @returns {Object} return[].statusCategory - Status category details
   *
   * @throws {JiraApiError} If API request fails
   */
  async getAllStatuses () {
    const logger = this.logger.child('getAllStatuses')
    const endOp = logger.startOperation('getAllStatuses')

    try {
      logger.info('Fetching all statuses')

      const response = await this.request('/status')
      const statuses = await response.json()

      logger.info(`Retrieved ${statuses.length} statuses`, {
        statuses: statuses.map(s => s.name),
      })

      endOp('success', { count: statuses.length })
      return statuses
    } catch (error) {
      logger.error('Failed to get statuses', error)
      endOp('failure', { error: error.message })
      throw error
    }
  }

  // ==========================================================================
  // TRANSITION PATH FINDING METHODS
  // ==========================================================================

  /**
   * Find all possible paths between two statuses using DFS
   * @param {Object} stateMachine - The workflow state machine
   * @param {string} fromStatusName - Starting status name
   * @param {string} toStatusName - Target status name
   * @returns {Array<Array<Object>>} Array of paths
   * @throws {JiraValidationError} If status names are not found
   */
  findAllTransitionPaths (stateMachine, fromStatusName, toStatusName) {
    const logger = this.logger.child('findAllTransitionPaths')

    logger.debug('Finding all transition paths', {
      from: fromStatusName,
      to: toStatusName,
    })

    let fromStatusId = null
    let toStatusId = null

    // Find status IDs by name
    for (const [ statusId, status ] of Object.entries(stateMachine.states)) {
      if (status.name === fromStatusName) fromStatusId = statusId
      if (status.name === toStatusName) toStatusId = statusId
    }

    if (!fromStatusId || !toStatusId) {
      throw new JiraValidationError(
        `Status not found: ${!fromStatusId ? fromStatusName : toStatusName}`,
        'statusName',
        !fromStatusId ? fromStatusName : toStatusName
      )
    }

    // Already at destination
    if (fromStatusId === toStatusId) {
      logger.debug('Source and target are the same', {
        from: fromStatusName,
        to: toStatusName,
      })
      return [ [] ]
    }

    const paths = []
    const visited = new Set()

    // DFS to find all paths
    const dfs = (currentId, path) => {
      if (currentId === toStatusId) {
        paths.push([ ...path ])
        return
      }

      // Check for excessive depth (potential circular reference)
      if (path.length > JIRA_CONSTANTS.VALIDATION.MAX_PATH_DEPTH) {
        logger.warn('Path depth exceeded maximum', {
          maxDepth: JIRA_CONSTANTS.VALIDATION.MAX_PATH_DEPTH,
          currentDepth: path.length,
        })
        return
      }

      visited.add(currentId)

      const transitions = stateMachine.transitionMap.get(currentId)
      if (transitions) {
        for (const [ nextStatusId, transition ] of transitions) {
          if (!visited.has(nextStatusId)) {
            path.push({
              id: transition.id,
              name: transition.name,
              from: currentId,
              to: nextStatusId,
              fromName: stateMachine.states[currentId].name,
              toName: stateMachine.states[nextStatusId].name,
            })
            dfs(nextStatusId, path)
            path.pop()
          }
        }
      }

      visited.delete(currentId)
    }

    dfs(fromStatusId, [])

    logger.debug(`Found ${paths.length} possible paths`, {
      from: fromStatusName,
      to: toStatusName,
      pathCount: paths.length,
    })

    return paths
  }

  /**
   * Find the shortest path between two statuses using BFS
   * @param {Object} stateMachine - The workflow state machine
   * @param {string} fromStatusName - Starting status name
   * @param {string} toStatusName - Target status name
   * @param {Array<string>} [excludeStates=[]] - Status names to avoid in path
   * @returns {Array<Object>|null} Shortest path of transitions, or null if no path exists
   * @throws {JiraValidationError} If status names are not found
   */
  findShortestTransitionPath (
    stateMachine,
    fromStatusName,
    toStatusName,
    excludeStates = []
  ) {
    const logger = this.logger.child('findShortestTransitionPath')

    logger.debug('Finding shortest transition path', {
      from: fromStatusName,
      to: toStatusName,
      excludeStates,
    })

    let fromStatusId = null
    let toStatusId = null
    const excludeStatusIds = new Set()

    // Map status names to IDs
    for (const [ statusId, status ] of Object.entries(stateMachine.states)) {
      if (status.name === fromStatusName) fromStatusId = statusId
      if (status.name === toStatusName) toStatusId = statusId
      if (excludeStates.includes(status.name)) {
        excludeStatusIds.add(statusId)
      }
    }

    // Validate status names
    if (!fromStatusId || !toStatusId) {
      throw new JiraValidationError(
        `Status not found: ${!fromStatusId ? fromStatusName : toStatusName}`,
        'statusName',
        !fromStatusId ? fromStatusName : toStatusName
      )
    }

    // Already at destination
    if (fromStatusId === toStatusId) {
      logger.debug('Already at target status', {
        from: fromStatusName,
        to: toStatusName,
      })
      return []
    }

    // Check if target is excluded
    if (excludeStatusIds.has(toStatusId)) {
      logger.warn('Target status is in excluded states list', {
        targetStatus: toStatusName,
        excludeStates,
      })
      return null
    }

    // BFS to find shortest path
    const queue = [ { statusId: fromStatusId, path: [] } ]
    const visited = new Set([ fromStatusId ])

    while (queue.length > 0) {
      const { statusId: currentId, path } = queue.shift()

      // Check for excessive depth
      if (path.length > JIRA_CONSTANTS.VALIDATION.MAX_PATH_DEPTH) {
        logger.error('Path depth exceeded maximum - possible circular workflow', {
          maxDepth: JIRA_CONSTANTS.VALIDATION.MAX_PATH_DEPTH,
          currentDepth: path.length,
          from: fromStatusName,
          to: toStatusName,
        })
        return null
      }

      const transitions = stateMachine.transitionMap.get(currentId)
      if (transitions) {
        for (const [ nextStatusId, transition ] of transitions) {
          // Skip excluded statuses (unless it's the target)
          if (excludeStatusIds.has(nextStatusId) && nextStatusId !== toStatusId) {
            continue
          }

          // Found the target
          if (nextStatusId === toStatusId) {
            const shortestPath = [
              ...path,
              {
                id: transition.id,
                name: transition.name,
                from: currentId,
                to: nextStatusId,
                fromName: stateMachine.states[currentId].name,
                toName: stateMachine.states[nextStatusId].name,
              },
            ]

            logger.info('Found shortest path', {
              from: fromStatusName,
              to: toStatusName,
              steps: shortestPath.length,
              path: shortestPath.map(t => t.name),
            })

            return shortestPath
          }

          // Continue searching
          if (!visited.has(nextStatusId)) {
            visited.add(nextStatusId)
            queue.push({
              statusId: nextStatusId,
              path: [
                ...path,
                {
                  id: transition.id,
                  name: transition.name,
                  from: currentId,
                  to: nextStatusId,
                  fromName: stateMachine.states[currentId].name,
                  toName: stateMachine.states[nextStatusId].name,
                },
              ],
            })
          }
        }
      }
    }

    logger.warn('No path found between statuses', {
      from: fromStatusName,
      to: toStatusName,
      excludeStates,
      visitedCount: visited.size,
    })

    return null
  }

  // ==========================================================================
  // FIELD & TRANSITION METADATA METHODS
  // ==========================================================================

  /**
   * Get available transitions for a Jira issue
   * @param {string} issueKey - Jira issue key
   * @returns {Promise<Array<Object>>} Available transitions
   * @throws {JiraValidationError} If issueKey is invalid
   * @throws {JiraApiError} If API request fails
   */
  async getTransitions (issueKey) {
    const logger = this.logger.child('getTransitions')
    const endOp = logger.startOperation('getTransitions', { issueKey })

    try {
      const validatedKey = this._validateIssueKey(issueKey)

      logger.debug('Fetching available transitions', { issueKey: validatedKey })

      const response = await this.request(`/issue/${validatedKey}/transitions`)
      const data = await response.json()
      const transitions = data.transitions || []

      logger.debug(`Retrieved ${transitions.length} available transitions`, {
        issueKey: validatedKey,
        transitions: transitions.map(t => `${t.name} → ${t.to.name}`),
      })

      endOp('success', { count: transitions.length })
      return transitions
    } catch (error) {
      logger.error('Failed to get transitions', error)
      endOp('failure', { error: error.message })
      throw error
    }
  }

  /**
   * Get detailed information about a specific transition including required fields
   * @param {string} issueKey - Jira issue key
   * @param {string} transitionId - Transition ID
   * @returns {Promise<Object>} Transition details including fields metadata
   * @throws {JiraValidationError} If parameters are invalid
   * @throws {JiraApiError} If API request fails
   */
  async getTransitionDetails (issueKey, transitionId) {
    const logger = this.logger.child('getTransitionDetails')
    const endOp = logger.startOperation('getTransitionDetails', {
      issueKey,
      transitionId,
    })

    try {
      const validatedKey = this._validateIssueKey(issueKey)

      if (!transitionId || typeof transitionId !== 'string') {
        throw new JiraValidationError(
          'Transition ID must be a non-empty string',
          'transitionId',
          transitionId
        )
      }

      logger.debug('Fetching transition details', {
        issueKey: validatedKey,
        transitionId,
      })

      const response = await this.request(
        `/issue/${validatedKey}/transitions?transitionId=${transitionId}&expand=transitions.fields`
      )
      const data = await response.json()
      const transition = data.transitions.find((t) => t.id === transitionId)

      if (!transition) {
        logger.warn('Transition not found or not available', {
          issueKey: validatedKey,
          transitionId,
          availableTransitions: data.transitions.map(t => t.id),
        })
        return {}
      }

      const requiredFields = []
      const optionalFields = []

      if (transition.fields) {
        for (const [ fieldId, fieldInfo ] of Object.entries(transition.fields)) {
          if (fieldInfo.required) {
            requiredFields.push({ fieldId, name: fieldInfo.name })
          } else {
            optionalFields.push({ fieldId, name: fieldInfo.name })
          }
        }
      }

      logger.debug('Retrieved transition details', {
        issueKey: validatedKey,
        transitionId,
        transitionName: transition.name,
        requiredFields,
        optionalFields,
      })

      endOp('success', {
        requiredFieldsCount: requiredFields.length,
        optionalFieldsCount: optionalFields.length,
      })

      return transition
    } catch (error) {
      logger.error('Failed to get transition details', error)
      endOp('failure', { error: error.message })
      throw error
    }
  }

  /**
   * Get available options for a specific field type
   * @param {string} fieldName - Field name (resolution, priority, issuetype, component, version)
   * @returns {Promise<Array<Object>>} Available options for the field
   * @throws {JiraValidationError} If fieldName is invalid
   * @throws {JiraApiError} If API request fails
   */
  async getFieldOptions (fieldName) {
    const logger = this.logger.child('getFieldOptions')
    const endOp = logger.startOperation('getFieldOptions', { fieldName })

    try {
      if (!fieldName || typeof fieldName !== 'string') {
        throw new JiraValidationError(
          'Field name must be a non-empty string',
          'fieldName',
          fieldName
        )
      }

      const endpoint = JIRA_CONSTANTS.FIELD_MAPPINGS[fieldName]

      if (!endpoint) {
        logger.warn('No endpoint mapping for field', {
          fieldName,
          availableFields: Object.keys(JIRA_CONSTANTS.FIELD_MAPPINGS),
        })
        endOp('success', { count: 0 })
        return []
      }

      logger.debug('Fetching field options', { fieldName, endpoint })

      const response = await this.request(endpoint)
      const options = await response.json()

      logger.debug(`Retrieved ${options.length} options for field`, {
        fieldName,
        options: options.map(o => o.name || o.id),
      })

      endOp('success', { count: options.length })
      return options
    } catch (error) {
      logger.error('Failed to get field options', error)
      endOp('failure', { error: error.message })
      return []
    }
  }

  /**
   * Get default field value based on field type and context
   * @private
   * @param {string} issueKey - Issue key for context
   * @param {string} fieldId - Field ID
   * @param {Object} fieldInfo - Field metadata from transition details
   * @returns {Promise<*>} Default value for the field, or null if no default available
   */
  async _getDefaultFieldValue (issueKey, fieldId, fieldInfo) {
    const logger = this.logger.child('getDefaultFieldValue')

    logger.debug('Getting default field value', {
      issueKey,
      fieldId,
      fieldName: fieldInfo.name,
    })

    try {
      // Handle resolution field
      if (fieldId === 'resolution' || fieldInfo.name === 'Resolution') {
        const resolutions = await this.getFieldOptions('resolution')

        // Try to find "Done" resolution first
        let resolution = resolutions.find((r) => r.name === 'Done')

        // Fallback to first available resolution
        if (!resolution && resolutions.length > 0) {
          resolution = resolutions[0]
        }

        if (resolution) {
          logger.info('Using default resolution', {
            issueKey,
            resolutionId: resolution.id,
            resolutionName: resolution.name,
          })
          return { id: resolution.id }
        }
      }

      // Handle priority field
      if (fieldId === 'priority' || fieldInfo.name === 'Priority') {
        const priorities = await this.getFieldOptions('priority')

        // Try to find "Medium" priority first
        let priority = priorities.find((p) => p.name === 'Medium')

        // Fallback to first available priority
        if (!priority && priorities.length > 0) {
          priority = priorities[0]
        }

        if (priority) {
          logger.info('Using default priority', {
            issueKey,
            priorityId: priority.id,
            priorityName: priority.name,
          })
          return { id: priority.id }
        }
      }

      logger.warn('No default value available for field', {
        issueKey,
        fieldId,
        fieldName: fieldInfo.name,
      })

      return null
    } catch (error) {
      logger.error('Failed to get default field value', error)
      return null
    }
  }

  // ==========================================================================
  // ISSUE TRANSITION METHODS - CORE FUNCTIONALITY
  // ==========================================================================

  /**
   * Transition an issue through multiple states to reach target status.
   * Automatically detects and populates required fields (e.g., Resolution).
   * @param {string} issueKey - Jira issue key
   * @param {string} targetStatusName - Target status name
   * @param {string[]} [excludeStates] - Status names to avoid in transition path
   * @param {Object.<string, *>} [fields={}] - Additional fields for final transition
   * @returns {Promise<boolean>} True if successful
   * @throws {JiraValidationError} If issueKey format is invalid
   * @throws {JiraApiError} If API request fails after retries
   * @throws {JiraTransitionError} If no valid transition path exists
   */
  async transitionIssue (
    issueKey,
    targetStatusName,
    excludeStates = JIRA_CONSTANTS.DEFAULT_EXCLUDE_STATES,
    fields = {}
  ) {
    const logger = this.logger.child('transitionIssue')
    const endOp = logger.startOperation('transitionIssue', {
      issueKey,
      targetStatus: targetStatusName,
      excludeStates,
      providedFields: Object.keys(fields),
    })

    try {
      // Validate inputs
      const validatedKey = this._validateIssueKey(issueKey)

      if (!targetStatusName || typeof targetStatusName !== 'string') {
        throw new JiraValidationError(
          'Target status name must be a non-empty string',
          'targetStatusName',
          targetStatusName
        )
      }

      if (!Array.isArray(excludeStates)) {
        throw new JiraValidationError(
          'Exclude states must be an array',
          'excludeStates',
          excludeStates
        )
      }

      logger.info('Starting issue transition', {
        issueKey: validatedKey,
        targetStatus: targetStatusName,
        excludeStates,
      })

      // Get current issue status
      const issueResponse = await this.request(
        `/issue/${validatedKey}?fields=status,resolution,issuetype`
      )
      const issueData = await issueResponse.json()
      const currentStatusName = issueData.fields.status.name
      const currentResolution = issueData.fields.resolution
      const issueType = issueData.fields.issuetype

      logger.debug('Current issue state', {
        issueKey: validatedKey,
        currentStatus: currentStatusName,
        targetStatus: targetStatusName,
        currentResolution: currentResolution?.name || 'Unresolved',
        issueType: issueType.name,
      })

      // Check if already at target status
      if (currentStatusName === targetStatusName) {
        logger.info('Issue already at target status', {
          issueKey: validatedKey,
          status: targetStatusName,
        })
        endOp('success', { alreadyAtTarget: true })
        return true
      }

      // Get workflow for this project
      const projectKey = this._extractProjectKey(validatedKey)
      const workflowName = await this.getProjectWorkflowName(projectKey)
      const stateMachine = await this.getWorkflowStateMachine(workflowName)

      logger.debug('Retrieved workflow information', {
        projectKey,
        workflowName,
        statusCount: Object.keys(stateMachine.states).length,
      })

      // Find shortest transition path
      const shortestPath = this.findShortestTransitionPath(
        stateMachine,
        currentStatusName,
        targetStatusName,
        excludeStates
      )

      if (!shortestPath) {
        throw new JiraTransitionError(
          `No transition path found from "${currentStatusName}" to "${targetStatusName}"`,
          validatedKey,
          currentStatusName,
          targetStatusName,
          `Avoiding states: ${excludeStates.join(', ')}`
        )
      }

      logger.info(`Found transition path with ${shortestPath.length} step(s)`, {
        issueKey: validatedKey,
        steps: shortestPath.length,
        path: shortestPath.map(t => `${t.fromName} → ${t.toName}`),
      })

      // Execute each transition in the path
      for (let i = 0; i < shortestPath.length; i++) {
        const transition = shortestPath[i]
        const isLastTransition = i === shortestPath.length - 1
        const stepNumber = i + 1

        logger.info(`Executing transition step ${stepNumber}/${shortestPath.length}`, {
          issueKey: validatedKey,
          from: transition.fromName,
          to: transition.toName,
          transitionName: transition.name,
        })

        // Get available transitions for the issue
        const availableTransitions = await this.getTransitions(validatedKey)

        // Find the actual transition object
        const actualTransition = availableTransitions.find(
          (t) =>
            t.id === transition.id ||
            (t.to.name === transition.toName && t.name === transition.name)
        )

        if (!actualTransition) {
          const available = availableTransitions.map(t => `${t.name} → ${t.to.name}`)

          logger.error('Transition not available for issue', {
            issueKey: validatedKey,
            requestedTransition: `${transition.name} → ${transition.toName}`,
            availableTransitions: available,
          })

          throw new JiraTransitionError(
            `Transition "${transition.name}" to "${transition.toName}" not available`,
            validatedKey,
            transition.fromName,
            transition.toName,
            `Available: ${available.join(', ')}`
          )
        }

        // Build transition payload
        const transitionPayload = {
          transition: {
            id: actualTransition.id,
          },
          fields: {},
        }

        // Add provided fields only on last transition
        if (isLastTransition && Object.keys(fields).length > 0) {
          transitionPayload.fields = { ...fields }
          logger.debug('Adding provided fields to final transition', {
            issueKey: validatedKey,
            fields: Object.keys(fields),
          })
        }

        // **CRITICAL FIX**: Auto-populate required fields
        const transitionDetails = await this.getTransitionDetails(
          validatedKey,
          actualTransition.id
        )

        if (transitionDetails.fields) {
          const requiredFields = []
          const missingFields = []

          for (const [ fieldId, fieldInfo ] of Object.entries(transitionDetails.fields)) {
            if (fieldInfo.required) {
              requiredFields.push({ fieldId, name: fieldInfo.name })

              // Check if field is already provided
              if (!transitionPayload.fields[fieldId]) {
                logger.warn('Required field not provided - attempting auto-population', {
                  issueKey: validatedKey,
                  fieldId,
                  fieldName: fieldInfo.name,
                  transition: transition.toName,
                })

                // Try to get default value
                const defaultValue = await this._getDefaultFieldValue(
                  validatedKey,
                  fieldId,
                  fieldInfo
                )

                if (defaultValue) {
                  transitionPayload.fields[fieldId] = defaultValue

                  logger.info('Auto-populated required field with default value', {
                    issueKey: validatedKey,
                    fieldId,
                    fieldName: fieldInfo.name,
                    defaultValue,
                  })
                } else {
                  missingFields.push({ fieldId, name: fieldInfo.name })
                }
              }
            }
          }

          logger.debug('Required fields analysis', {
            issueKey: validatedKey,
            transition: transition.toName,
            requiredFields,
            missingFields,
            providedFields: Object.keys(transitionPayload.fields),
          })

          // If there are still missing required fields, throw error
          if (missingFields.length > 0) {
            throw new JiraTransitionError(
              `Required fields cannot be populated: ${missingFields.map(f => f.name).join(', ')}`,
              validatedKey,
              transition.fromName,
              transition.toName,
              `Missing fields: ${JSON.stringify(missingFields)}`
            )
          }
        }

        // Execute the transition
        logger.debug('Executing transition with payload', {
          issueKey: validatedKey,
          transitionId: actualTransition.id,
          fields: Object.keys(transitionPayload.fields),
        })

        await this.request(`/issue/${validatedKey}/transitions`, {
          method: 'POST',
          body: JSON.stringify(transitionPayload),
        })

        logger.info(`✓ Successfully executed transition step ${stepNumber}/${shortestPath.length}`, {
          issueKey: validatedKey,
          from: transition.fromName,
          to: transition.toName,
        })

        // Small delay to ensure Jira processes the transition
        if (i < shortestPath.length - 1) {
          await this._sleep(JIRA_CONSTANTS.DELAYS.TRANSITION_MS)
        }
      }

      logger.info('✓ Successfully transitioned issue to target status', {
        issueKey: validatedKey,
        from: currentStatusName,
        to: targetStatusName,
        steps: shortestPath.length,
      })

      endOp('success', {
        from: currentStatusName,
        to: targetStatusName,
        steps: shortestPath.length,
      })

      return true
    } catch (error) {
      logger.error('Failed to transition issue', error)
      endOp('failure', { error: error.message })
      throw error
    }
  }

  /**
   * Update multiple issues from commit history to a target status
   * @param {string[]} issueKeys - Array of Jira issue keys
   * @param {string} targetStatus - Target status name
   * @param {string[]} [excludeStates] - Status names to avoid in transition paths
   * @param {Object} [fields={}] - Additional fields to set during transitions
   * @returns {Promise<Object>} Summary with successful/failed counts and errors
   * @throws {JiraValidationError} If inputs are invalid
   */
  async updateIssuesFromCommitHistory (
    issueKeys,
    targetStatus,
    excludeStates = JIRA_CONSTANTS.DEFAULT_EXCLUDE_STATES,
    fields = {}
  ) {
    const logger = this.logger.child('updateIssuesFromCommitHistory')
    const endOp = logger.startOperation('updateIssuesFromCommitHistory', {
      issueCount: issueKeys?.length,
      targetStatus,
    })

    try {
      // Validate inputs
      if (!Array.isArray(issueKeys) || issueKeys.length === 0) {
        logger.info('No issue keys provided for update')
        endOp('success', { successful: 0, failed: 0 })
        return { successful: 0, failed: 0, errors: [] }
      }

      logger.info(`Updating ${issueKeys.length} issues to status: ${targetStatus}`, {
        issueKeys,
        targetStatus,
        excludeStates,
      })

      // Execute transitions in parallel
      const results = await Promise.allSettled(
        issueKeys.map((issueKey) =>
          this.transitionIssue(issueKey, targetStatus, excludeStates, fields)
        )
      )

      // Analyze results
      const successful = results.filter((result) => result.status === 'fulfilled')
      const failed = results.filter((result) => result.status === 'rejected')
      const errors = failed.map((result) => result.reason?.message || 'Unknown error')

      logger.info(`Update summary: ${successful.length} successful, ${failed.length} failed`, {
        successful: successful.length,
        failed: failed.length,
        totalAttempted: issueKeys.length,
      })

      if (failed.length > 0) {
        logger.warn('Some updates failed', {
          failedCount: failed.length,
          errors,
        })
      }

      endOp('success', {
        successful: successful.length,
        failed: failed.length,
      })

      return {
        successful: successful.length,
        failed: failed.length,
        errors,
      }
    } catch (error) {
      logger.error('Failed to update issues from commit history', error)
      endOp('failure', { error: error.message })
      throw error
    }
  }

  // ==========================================================================
  // CUSTOM FIELD METHODS
  // ==========================================================================

  /**
   * Update a single custom field on an issue
   * @param {string} issueKey - Jira issue key
   * @param {string} customFieldId - Custom field ID
   * @param {*} value - Value to set
   * @returns {Promise<boolean>} True if successful
   * @throws {JiraValidationError} If parameters are invalid
   * @throws {JiraApiError} If API request fails
   */
  async updateCustomField (issueKey, customFieldId, value) {
    const logger = this.logger.child('updateCustomField')
    const endOp = logger.startOperation('updateCustomField', {
      issueKey,
      customFieldId,
    })

    try {
      const validatedKey = this._validateIssueKey(issueKey)

      if (!customFieldId || typeof customFieldId !== 'string') {
        throw new JiraValidationError(
          'Custom field ID must be a non-empty string',
          'customFieldId',
          customFieldId
        )
      }

      logger.info('Updating custom field', {
        issueKey: validatedKey,
        customFieldId,
        valueType: typeof value,
      })

      const updatePayload = {
        fields: {
          [customFieldId]: value,
        },
      }

      await this.request(`/issue/${validatedKey}`, {
        method: 'PUT',
        body: JSON.stringify(updatePayload),
      })

      logger.info('✓ Successfully updated custom field', {
        issueKey: validatedKey,
        customFieldId,
      })

      endOp('success')
      return true
    } catch (error) {
      logger.error('Failed to update custom field', error)
      endOp('failure', { error: error.message })
      throw error
    }
  }

  /**
   * Update multiple custom fields on an issue
   * @param {string} issueKey - Jira issue key
   * @param {Object.<string, *>} customFields - Object with custom field IDs as keys
   * @returns {Promise<boolean>} True if successful
   * @throws {JiraValidationError} If parameters are invalid
   * @throws {JiraApiError} If API request fails
   */
  async updateCustomFields (issueKey, customFields) {
    const logger = this.logger.child('updateCustomFields')
    const endOp = logger.startOperation('updateCustomFields', {
      issueKey,
      fieldCount: Object.keys(customFields || {}).length,
    })

    try {
      const validatedKey = this._validateIssueKey(issueKey)

      if (!customFields || typeof customFields !== 'object') {
        throw new JiraValidationError(
          'Custom fields must be an object',
          'customFields',
          customFields
        )
      }

      const fieldCount = Object.keys(customFields).length

      if (fieldCount === 0) {
        logger.info('No custom fields to update')
        endOp('success', { fieldCount: 0 })
        return true
      }

      logger.info(`Updating ${fieldCount} custom fields`, {
        issueKey: validatedKey,
        fields: Object.keys(customFields),
      })

      const updatePayload = {
        fields: customFields,
      }

      await this.request(`/issue/${validatedKey}`, {
        method: 'PUT',
        body: JSON.stringify(updatePayload),
      })

      logger.info(`✓ Successfully updated ${fieldCount} custom fields`, {
        issueKey: validatedKey,
        fields: Object.keys(customFields),
      })

      endOp('success', { fieldCount })
      return true
    } catch (error) {
      logger.error('Failed to update custom fields', error)
      endOp('failure', { error: error.message })
      throw error
    }
  }

  /**
   * Get custom field value from an issue
   * @param {string} issueKey - Jira issue key
   * @param {string} customFieldId - Custom field ID
   * @returns {Promise<*>} Custom field value
   * @throws {JiraValidationError} If parameters are invalid
   * @throws {JiraApiError} If API request fails
   */
  async getCustomField (issueKey, customFieldId) {
    const logger = this.logger.child('getCustomField')
    const endOp = logger.startOperation('getCustomField', {
      issueKey,
      customFieldId,
    })

    try {
      const validatedKey = this._validateIssueKey(issueKey)

      if (!customFieldId || typeof customFieldId !== 'string') {
        throw new JiraValidationError(
          'Custom field ID must be a non-empty string',
          'customFieldId',
          customFieldId
        )
      }

      logger.debug('Fetching custom field', {
        issueKey: validatedKey,
        customFieldId,
      })

      const response = await this.request(
        `/issue/${validatedKey}?fields=${customFieldId}`
      )
      const issueData = await response.json()
      const value = issueData.fields[customFieldId]

      logger.debug('Retrieved custom field value', {
        issueKey: validatedKey,
        customFieldId,
        hasValue: value !== null && value !== undefined,
      })

      endOp('success')
      return value
    } catch (error) {
      logger.error('Failed to get custom field', error)
      endOp('failure', { error: error.message })
      throw error
    }
  }

  // ==========================================================================
  // ISSUE SEARCH METHODS
  // ==========================================================================

  /**
   * Find issues by status using JQL
   * @param {string} status - Status to search for
   * @param {number} [maxResults] - Maximum results to return
   * @param {string[]} [fields] - Fields to include in response
   * @returns {Promise<Array<Object>>} Array of issues
   * @throws {JiraValidationError} If parameters are invalid
   * @throws {JiraApiError} If API request fails
   */
  async findByStatus (
    status,
    maxResults = JIRA_CONSTANTS.MAX_RESULTS.DEFAULT,
    fields = [ 'key', 'summary', 'status' ]
  ) {
    const logger = this.logger.child('findByStatus')
    const endOp = logger.startOperation('findByStatus', { status, maxResults })

    try {
      if (!status || typeof status !== 'string') {
        throw new JiraValidationError(
          'Status must be a non-empty string',
          'status',
          status
        )
      }

      logger.info('Searching for issues by status', { status, maxResults })

      const jql = `status = "${status}"`

      const response = await this.request('/search', {
        method: 'POST',
        body: JSON.stringify({
          jql,
          fields,
          maxResults,
        }),
      })

      const data = await response.json()
      const issues = data.issues || []

      logger.info(`Found ${issues.length} issues in "${status}" status`, {
        status,
        count: issues.length,
        issueKeys: issues.map(i => i.key),
      })

      endOp('success', { count: issues.length })
      return issues
    } catch (error) {
      logger.error('Failed to find issues by status', error)
      endOp('failure', { error: error.message })
      throw error
    }
  }

  /**
   * Update issues with a specific status to a new status
   * @param {string} currentStatus - Current status to search for
   * @param {string} newStatus - New status to transition to
   * @param {Object} [fields={}] - Additional fields for transition
   * @returns {Promise<Array<Object>>} Updated issues
   * @throws {JiraApiError} If operations fail
   */
  async updateByStatus (currentStatus, newStatus, fields = {}) {
    const logger = this.logger.child('updateByStatus')
    const endOp = logger.startOperation('updateByStatus', {
      currentStatus,
      newStatus,
    })

    try {
      const issues = await this.findByStatus(currentStatus)

      logger.info(`Found ${issues.length} issues to update`, {
        currentStatus,
        newStatus,
        issueKeys: issues.map(i => i.key),
      })

      const settledPromises = await Promise.allSettled(
        issues.map((issue) =>
          this.transitionIssue(
            issue.key,
            newStatus,
            JIRA_CONSTANTS.DEFAULT_EXCLUDE_STATES,
            fields
          )
        )
      )

      const successful = settledPromises.filter((r) => r.status === 'fulfilled')
      const failed = settledPromises.filter((r) => r.status === 'rejected')

      logger.info(`Update complete: ${successful.length} succeeded, ${failed.length} failed`, {
        successful: successful.length,
        failed: failed.length,
      })

      if (failed.length > 0) {
        logger.warn('Some updates failed', {
          errors: failed.map(r => r.reason?.message),
        })
      }

      endOp('success', {
        successful: successful.length,
        failed: failed.length,
      })

      return issues
    } catch (error) {
      logger.error('Failed to update issues by status', error)
      endOp('failure', { error: error.message })
      throw error
    }
  }

  /**
   * Find and update issues that mention a PR URL
   * @param {string} prUrl - PR URL to search for
   * @param {string} newStatus - New status to transition to
   * @param {Object} [fields={}] - Additional fields for transition
   * @returns {Promise<number>} Count of issues updated
   * @throws {JiraApiError} If operations fail
   */
  async updateByPR (prUrl, newStatus, fields = {}) {
    const logger = this.logger.child('updateByPR')
    const endOp = logger.startOperation('updateByPR', { prUrl, newStatus })

    try {
      if (!prUrl || typeof prUrl !== 'string') {
        throw new JiraValidationError(
          'PR URL must be a non-empty string',
          'prUrl',
          prUrl
        )
      }

      logger.info('Searching for issues mentioning PR', { prUrl })

      const jql = `text ~ "${prUrl}"`

      const response = await this.request('/search', {
        method: 'POST',
        body: JSON.stringify({
          jql,
          fields: [ 'key', 'summary', 'status', 'description' ],
          maxResults: JIRA_CONSTANTS.MAX_RESULTS.SEARCH,
        }),
      })

      const data = await response.json()
      const issues = data.issues || []

      logger.info(`Found ${issues.length} issues mentioning PR ${prUrl}`, {
        prUrl,
        issueKeys: issues.map(i => i.key),
      })

      for (const issue of issues) {
        await this.transitionIssue(
          issue.key,
          newStatus,
          JIRA_CONSTANTS.DEFAULT_EXCLUDE_STATES,
          fields
        )
      }

      endOp('success', { count: issues.length })
      return issues.length
    } catch (error) {
      logger.error('Failed to update issues by PR', error)
      endOp('failure', { error: error.message })
      throw error
    }
  }

  // ==========================================================================
  // GIT INTEGRATION METHODS
  // ==========================================================================

  /**
   * Extract Jira issue keys from commit messages
   * @param {string|string[]} commitMessages - Commit message(s) to parse
   * @returns {string[]} Array of unique Jira issue keys found
   */
  extractIssueKeysFromCommitMessages (commitMessages) {
    const logger = this.logger.child('extractIssueKeysFromCommitMessages')

    try {
      // Handle both array and string inputs
      const messages = Array.isArray(commitMessages)
        ? commitMessages.join(' ')
        : commitMessages

      const issueKeys = new Set()

      if (messages) {
        const matches = messages.match(JIRA_CONSTANTS.VALIDATION.ISSUE_KEY_EXTRACT_PATTERN)
        if (matches) {
          matches.forEach((key) => {
            // Validate each key before adding
            if (JIRA_CONSTANTS.VALIDATION.ISSUE_KEY_PATTERN.test(key)) {
              issueKeys.add(key)
            }
          })
        }
      }

      const uniqueKeys = Array.from(issueKeys)

      logger.debug(`Extracted ${uniqueKeys.length} unique Jira issue keys`, {
        keys: uniqueKeys,
        sourceLength: messages?.length || 0,
      })

      return uniqueKeys
    } catch (error) {
      logger.error('Failed to extract issue keys from commit messages', error)
      return []
    }
  }

  /**
   * Extract Jira issue keys from GitHub context (for GitHub Actions)
   * @param {Object} context - GitHub Actions context object
   * @returns {string[]} Array of unique Jira issue keys found
   */
  extractIssueKeysFromGitHubContext (context) {
    const logger = this.logger.child('extractIssueKeysFromGitHubContext')

    try {
      const issueKeys = new Set()

      // Extract from commit messages in payload
      if (context.payload?.commits) {
        context.payload.commits.forEach((commit) => {
          const commitMessage = commit.message || ''
          const matches = commitMessage.match(
            JIRA_CONSTANTS.VALIDATION.ISSUE_KEY_EXTRACT_PATTERN
          )
          if (matches) {
            matches.forEach((key) => issueKeys.add(key))
          }
        })
      }

      // Extract from head commit message
      if (context.payload?.head_commit?.message) {
        const matches = context.payload.head_commit.message.match(
          JIRA_CONSTANTS.VALIDATION.ISSUE_KEY_EXTRACT_PATTERN
        )
        if (matches) {
          matches.forEach((key) => issueKeys.add(key))
        }
      }

      const uniqueKeys = Array.from(issueKeys)

      logger.info(`Found ${uniqueKeys.length} unique Jira issue keys in GitHub context`, {
        keys: uniqueKeys,
        commitsChecked: context.payload?.commits?.length || 0,
      })

      return uniqueKeys
    } catch (error) {
      logger.error('Failed to extract issue keys from GitHub context', error)
      return []
    }
  }

  /**
   * Extract unique Jira issue keys from git commit history between two refs
   * @param {string} fromRef - Starting git ref (exclusive)
   * @param {string} toRef - Ending git ref (inclusive)
   * @returns {Promise<string[]>} Array of unique Jira issue keys found
   */
  async getIssueKeysFromCommitHistory (fromRef, toRef) {
    const { execSync } = require('node:child_process')
    const logger = this.logger.child('getIssueKeysFromCommitHistory')

    // Validate input parameters
    if (
      !fromRef ||
      !toRef ||
      typeof fromRef !== 'string' ||
      typeof toRef !== 'string'
    ) {
      logger.warn('Invalid git ref parameters', { fromRef, toRef })
      return []
    }

    logger.debug('Extracting issue keys from git commit history', {
      fromRef,
      toRef,
    })

    let commitMessages = ''

    try {
      // Execute git log to get commit messages in range
      commitMessages = execSync(`git log --pretty=%B ${fromRef}..${toRef}`, {
        encoding: 'utf8',
        stdio: [ 'ignore', 'pipe', 'ignore' ],
      })

      logger.debug('Retrieved git commit messages', {
        fromRef,
        toRef,
        messageLength: commitMessages.length,
      })
    } catch (gitErr) {
      // Handle expected errors gracefully
      if (
        gitErr.status === 128 ||
        (gitErr.message && /fatal:/i.test(gitErr.message))
      ) {
        logger.info('No commits found in range or invalid refs', {
          fromRef,
          toRef,
        })
        return []
      }

      // Log unexpected errors
      logger.error('Git command failed', {
        error: gitErr.message,
        fromRef,
        toRef,
      })
      return []
    }

    // Handle empty commit messages
    if (!commitMessages || !commitMessages.trim()) {
      logger.debug('No commit messages in range', { fromRef, toRef })
      return []
    }

    // Extract issue keys using existing method
    const issueKeys = this.extractIssueKeysFromCommitMessages(commitMessages)

    // Filter for valid keys
    const validKeys = issueKeys.filter((k) =>
      JIRA_CONSTANTS.VALIDATION.ISSUE_KEY_PATTERN.test(k)
    )

    logger.info(`Extracted ${validKeys.length} issue keys from commit history`, {
      fromRef,
      toRef,
      keys: validKeys,
    })

    return [ ...new Set(validKeys) ]
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = Jira
