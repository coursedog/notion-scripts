/**
 * @fileoverview GitHub Actions - Jira Integration
 * @module update_jira
 * @version 2.0.0
 *
 * Automates Jira issue management based on GitHub events (PR actions, branch deployments).
 * Supports status transitions, custom field updates, and deployment tracking.
 */

require('dotenv').config()
const core = require('@actions/core')
const { Octokit } = require('@octokit/rest')
const Jira = require('./../utils/jira')
const fs = require('node:fs')

// ============================================================================
// CONSTANTS & CONFIGURATION
// ============================================================================

/**
 * GitHub Actions and workflow constants
 * @const {Object}
 */
const ACTION_CONSTANTS = {
  GITHUB_ACTIONS: {
    PULL_REQUEST: 'pull_request',
    PULL_REQUEST_TARGET: 'pull_request_target',
    PUSH: 'push',
  },

  PR_ACTIONS: {
    OPENED: 'opened',
    REOPENED: 'reopened',
    READY_FOR_REVIEW: 'ready_for_review',
    CONVERTED_TO_DRAFT: 'converted_to_draft',
    SYNCHRONIZE: 'synchronize',
    CLOSED: 'closed',
  },

  BRANCHES: {
    ALLOWED_REFS: [
      'refs/heads/master',
      'refs/heads/main',
      'refs/heads/staging',
      'refs/heads/dev',
    ],
    PRODUCTION: [ 'master', 'main' ],
    STAGING: 'staging',
    DEVELOPMENT: 'dev',
  },

  JIRA_STATUSES: {
    CODE_REVIEW: 'Code Review',
    IN_DEVELOPMENT: 'In Development',
    DONE: 'Done',
    DEPLOYED_TO_STAGING: 'Deployed to Staging',
    MERGED: 'Merged',
  },

  EXCLUDED_STATES: [ 'Blocked', 'Rejected' ],

  CUSTOM_FIELDS: {
    RELEASE_ENVIRONMENT: 'customfield_11473',
    STAGING_TIMESTAMP: 'customfield_11474',
    PRODUCTION_TIMESTAMP: 'customfield_11475',
  },

  RELEASE_ENV_IDS: {
    STAGING: '11942',
    PRODUCTION: '11943',
  },

  COMMIT_HISTORY: {
    PRODUCTION_MAX_COMMITS: 200,
    STAGING_MAX_COMMITS: 200,
  },

  VALIDATION: {
    ISSUE_KEY_PATTERN: /^[A-Z][A-Z0-9]+-\d+$/,
    ISSUE_KEY_EXTRACT_PATTERN: /[A-Z]+-[0-9]+/g,
    PR_NUMBER_PATTERN: /#([0-9]+)/,
  },

  RETRY: {
    MAX_ATTEMPTS: 3,
    BACKOFF_MULTIPLIER: 2,
    BASE_DELAY_MS: 1000,
  },

  GITHUB_API: {
    MAX_RESULTS: 50,
  },
}

/**
 * Status mapping configuration for different branch deployments.
 * Maps branch names to their corresponding Jira status and custom field updates.
 *
 * @type {Object.<string, BranchConfig>}
 */
const STATUS_MAP = {
  master: {
    status: ACTION_CONSTANTS.JIRA_STATUSES.DONE,
    transitionFields: {},
    customFields: {
      [ACTION_CONSTANTS.CUSTOM_FIELDS.PRODUCTION_TIMESTAMP]: () => new Date(),
      [ACTION_CONSTANTS.CUSTOM_FIELDS.RELEASE_ENVIRONMENT]: { id: ACTION_CONSTANTS.RELEASE_ENV_IDS.PRODUCTION },
    },
  },
  main: {
    status: ACTION_CONSTANTS.JIRA_STATUSES.DONE,
    transitionFields: {},
    customFields: {
      [ACTION_CONSTANTS.CUSTOM_FIELDS.PRODUCTION_TIMESTAMP]: () => new Date(),
      [ACTION_CONSTANTS.CUSTOM_FIELDS.RELEASE_ENVIRONMENT]: { id: ACTION_CONSTANTS.RELEASE_ENV_IDS.PRODUCTION },
    },
  },
  staging: {
    status: ACTION_CONSTANTS.JIRA_STATUSES.DEPLOYED_TO_STAGING,
    transitionFields: {},
    customFields: {
      [ACTION_CONSTANTS.CUSTOM_FIELDS.STAGING_TIMESTAMP]: () => new Date(),
      [ACTION_CONSTANTS.CUSTOM_FIELDS.RELEASE_ENVIRONMENT]: { id: ACTION_CONSTANTS.RELEASE_ENV_IDS.STAGING },
    },
  },
  dev: {
    status: ACTION_CONSTANTS.JIRA_STATUSES.MERGED,
    transitionFields: {},
    customFields: {},
  },
}

// ============================================================================
// CUSTOM ERROR CLASSES
// ============================================================================

/**
 * Base error class for GitHub Action errors
 * @extends Error
 */
class GitHubActionError extends Error {
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
 * Thrown when event processing fails
 * @extends GitHubActionError
 */
class EventProcessingError extends GitHubActionError {
  /**
   * @param {string} message - Error message
   * @param {string} eventType - GitHub event type
   * @param {Object} eventData - Event data object
   */
  constructor (message, eventType, eventData) {
    super(message, { eventType, eventData })
    this.eventType = eventType
  }
}

/**
 * Thrown when configuration is missing or invalid
 * @extends GitHubActionError
 */
class ConfigurationError extends GitHubActionError {
  /**
   * @param {string} message - Error message
   * @param {string[]} missingConfig - List of missing configuration keys
   */
  constructor (message, missingConfig) {
    super(message, { missingConfig })
    this.missingConfig = missingConfig
  }
}

/**
 * Thrown when GitHub API operations fail
 * @extends GitHubActionError
 */
class GitHubApiError extends GitHubActionError {
  /**
   * @param {string} message - Error message
   * @param {number} statusCode - HTTP status code
   * @param {string} operation - Operation that failed
   */
  constructor (message, statusCode, operation) {
    super(message, { statusCode, operation })
    this.statusCode = statusCode
    this.operation = operation
  }
}

// ============================================================================
// LOGGING SYSTEM
// ============================================================================

/**
 * Logger with context support and multiple log levels.
 * Provides structured logging with sensitive data masking.
 * @class Logger
 */
class Logger {
  /**
   * @param {string} [context='GitHubAction'] - Logger context/namespace
   * @param {string} [level='INFO'] - Minimum log level to output
   */
  constructor (context = 'GitHubAction', level = 'INFO') {
    this.context = context
    this.level = level
    this.levelPriority = {
      DEBUG: 0,
      INFO: 1,
      WARN: 2,
      ERROR: 3,
    }
    this.operationCounter = 0
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
   * Mask sensitive data in log output
   * @private
   * @param {Object} data - Data to mask
   * @returns {Object} Masked data
   */
  _maskSensitiveData (data) {
    if (!data || typeof data !== 'object') return data
    const clone = structuredClone(data)

    const sensitiveKeys = [
      'apiToken', 'token', 'password', 'secret', 'authorization',
      'JIRA_API_TOKEN', 'GITHUB_TOKEN', 'email',
    ]

    const maskObject = (obj) => {
      if (!obj || typeof obj !== 'object') return obj

      for (const key of Object.keys(obj)) {
        const lowerKey = key.toLowerCase()
        if (sensitiveKeys.some(sk => lowerKey.includes(sk.toLowerCase()))) {
          obj[key] = '***'
        } else if (key === 'headers' && obj[key]?.Authorization) {
          obj[key].Authorization = '***'
        } else if (typeof obj[key] === 'object') {
          maskObject(obj[key])
        }
      }
      return obj
    }

    return maskObject(clone)
  }

  /**
   * Core logging method
   * @private
   * @param {string} level - Log level
   * @param {string} message - Log message
   * @param {Object} [data={}] - Additional data to log
   */
  _log (level, message, data = {}) {
    if (!this._shouldLog(level)) return

    const output = `[${level}] [${this.context}] ${message}${Object.keys(data).length > 0 ? ` ${JSON.stringify(this._maskSensitiveData(data))}` : ''}`

    switch (level) {
      case 'ERROR':
        console.error(output)
        break
      case 'WARN':
        console.warn(output)
        break
      default:
        console.log(output)
    }
  }

  /**
   * Log debug message
   * @param {string} message - Log message
   * @param {Object} [data={}] - Additional data
   */
  debug (message, data = {}) {
    this._log('DEBUG', message, data)
  }

  /**
   * Log info message
   * @param {string} message - Log message
   * @param {Object} [data={}] - Additional data
   */
  info (message, data = {}) {
    this._log('INFO', message, data)
  }

  /**
   * Log warning message
   * @param {string} message - Log message
   * @param {Object} [data={}] - Additional data
   */
  warn (message, data = {}) {
    this._log('WARN', message, data)
  }

  /**
   * Log error message
   * @param {string} message - Log message
   * @param {Object} [data={}] - Additional data
   */
  error (message, data = {}) {
    this._log('ERROR', message, data)
  }

  /**
   * Start tracking an operation with automatic timing
   * @param {string} operation - Operation name
   * @param {Object} [params={}] - Operation parameters
   * @returns {Function} Finish function to call when operation completes
   */
  startOperation (operation, params = {}) {
    const operationId = `${operation}_${++this.operationCounter}_${Date.now()}`
    const startTime = Date.now()

    this.debug(`Operation started: ${operation}`, { operationId, ...params })

    return (status = 'success', result = {}) => {
      const duration = Date.now() - startTime
      this.info(`Operation completed: ${operation}`, {
        operationId,
        status,
        durationMs: duration,
        ...result,
      })
    }
  }
}

// Create global logger instance
const logger = new Logger('GitHubAction', process.env.DEBUG === 'true' ? 'DEBUG' : 'INFO')

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

/**
 * Detect runtime environment
 * @returns {'github'|'ci'|'local'} Environment type
 */
function detectEnvironment () {
  if (process.env.GITHUB_ACTIONS === 'true') return 'github'
  if (process.env.CI === 'true') return 'ci'
  return 'local'
}

const ENVIRONMENT = detectEnvironment()

/**
 * Sleep for specified milliseconds
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
function sleep (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Construct GitHub PR URL from components
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {number|string} prNumber - PR number
 * @returns {string} Full PR URL
 */
function constructPrUrl (owner, repo, prNumber) {
  return `${owner}/${repo}/pull/${prNumber}`
}

/**
 * Extract owner and repo name from GitHub repository string
 * @param {string} repository - Repository in format "owner/repo"
 * @returns {{owner: string, repo: string}} Owner and repo
 * @throws {ConfigurationError} If repository format is invalid
 */
function parseRepository (repository) {
  if (!repository || !repository.includes('/')) {
    throw new ConfigurationError(
      `Invalid repository format: ${repository}. Expected "owner/repo"`,
      [ 'GITHUB_REPOSITORY' ]
    )
  }

  const [ owner, repo ] = repository.split('/')
  return { owner, repo }
}

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

/**
 * Validates required environment variables and configuration.
 * @returns {Object} Validated configuration object
 * @throws {ConfigurationError} If required configuration is missing or invalid
 */
function loadAndValidateConfiguration () {
  const finishOp = logger.startOperation('loadConfiguration')

  const config = {
    jira: {
      baseUrl: core.getInput('JIRA_BASE_URL') || process.env.JIRA_BASE_URL,
      email: core.getInput('JIRA_EMAIL') || process.env.JIRA_EMAIL,
      apiToken: core.getInput('JIRA_API_TOKEN') || process.env.JIRA_API_TOKEN,
      logLevel: process.env.DEBUG === 'true' ? 'DEBUG' : 'INFO',
    },
    github: {
      ref: process.env.GITHUB_REF,
      eventName: process.env.GITHUB_EVENT_NAME,
      eventPath: process.env.GITHUB_EVENT_PATH,
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN,
    },
    environment: ENVIRONMENT,
    dryRun: process.env.DRY_RUN === 'true',
  }

  // Validate required Jira config
  const requiredJira = [ 'baseUrl', 'email', 'apiToken' ]
  const missingJira = requiredJira.filter(key => !config.jira[key])

  if (missingJira.length > 0) {
    const missingEnvVars = missingJira.map(k => `JIRA_${k.toUpperCase()}`)
    const error = new ConfigurationError(
      `Missing required Jira configuration: ${missingJira.join(', ')}`,
      missingEnvVars
    )
    finishOp('error', { error: error.message })
    throw error
  }

  // Validate STATUS_MAP
  validateStatusMap()

  finishOp('success', {
    environment: config.environment,
    dryRun: config.dryRun,
  })

  logger.info('Configuration loaded successfully', {
    jiraBaseUrl: config.jira.baseUrl,
    environment: config.environment,
    dryRun: config.dryRun,
  })

  return config
}

/**
 * Validates STATUS_MAP configuration
 * @throws {ConfigurationError} If status map is invalid
 */
function validateStatusMap () {
  const requiredBranches = [ 'master', 'main', 'staging', 'dev' ]

  for (const branch of requiredBranches) {
    if (!STATUS_MAP[branch]) {
      throw new ConfigurationError(
        `Missing status configuration for branch: ${branch}`,
        [ `STATUS_MAP.${branch}` ]
      )
    }

    const config = STATUS_MAP[branch]
    if (!config.status) {
      throw new ConfigurationError(
        `Missing status field for branch: ${branch}`,
        [ `STATUS_MAP.${branch}.status` ]
      )
    }
  }

  logger.debug('STATUS_MAP validation passed', {
    branches: Object.keys(STATUS_MAP),
  })
}

/**
 * Validates event data structure before processing
 * @param {Object} eventData - Event payload
 * @param {string} eventType - Event type
 * @throws {EventProcessingError} If event data is invalid
 */
function validateEventData (eventData, eventType) {
  if (!eventData) {
    throw new EventProcessingError(
      'Event data is null or undefined',
      eventType,
      null
    )
  }

  if (eventType === ACTION_CONSTANTS.GITHUB_ACTIONS.PULL_REQUEST ||
      eventType === ACTION_CONSTANTS.GITHUB_ACTIONS.PULL_REQUEST_TARGET) {
    if (!eventData.pull_request) {
      throw new EventProcessingError(
        'Missing pull_request in event data',
        eventType,
        eventData
      )
    }
    if (!eventData.action) {
      throw new EventProcessingError(
        'Missing action in event data',
        eventType,
        eventData
      )
    }
  }

  logger.debug('Event data validation passed', { eventType })
  return true
}

/**
 * Validate issue key format
 * @param {string} issueKey - Issue key to validate
 * @returns {boolean} True if valid
 */
function isValidIssueKey (issueKey) {
  return ACTION_CONSTANTS.VALIDATION.ISSUE_KEY_PATTERN.test(issueKey)
}

// ============================================================================
// ISSUE KEY EXTRACTION & DEDUPLICATION
// ============================================================================

/**
 * Extracts and validates Jira issue keys from PR title and body.
 * @param {Object} pullRequest - GitHub PR object
 * @param {string} pullRequest.title - PR title
 * @param {string} [pullRequest.body] - PR body/description
 * @param {number} [pullRequest.number] - PR number
 * @returns {string[]} Array of validated, deduplicated Jira issue keys
 */
function extractJiraIssueKeys (pullRequest) {
  const finishOp = logger.startOperation('extractJiraIssueKeys', {
    prNumber: pullRequest.number,
  })

  const keys = new Set()
  const sources = [
    { type: 'title', content: pullRequest.title },
    { type: 'body', content: pullRequest.body },
  ].filter(s => s.content)

  for (const source of sources) {
    const matches = source.content.match(ACTION_CONSTANTS.VALIDATION.ISSUE_KEY_EXTRACT_PATTERN)
    if (matches) {
      for (const key of matches) {
        if (isValidIssueKey(key)) {
          keys.add(key)
        } else {
          logger.debug('Invalid issue key format filtered', {
            key,
            source: source.type,
          })
        }
      }
    }
  }

  const result = Array.from(keys)
  finishOp('success', { issueKeysFound: result.length })

  logger.info('Extracted issue keys from PR', {
    prNumber: pullRequest.number,
    issueKeys: result,
    sourcesChecked: sources.map(s => s.type),
  })

  return result
}

/**
 * Deduplicate and validate issue keys from multiple sources
 * @param {string[][]} issueKeysArrays - Arrays of issue keys from different sources
 * @returns {string[]} Deduplicated array of valid issue keys
 */
function deduplicateIssueKeys (...issueKeysArrays) {
  const uniqueKeys = new Set()
  const invalid = []

  for (const keys of issueKeysArrays) {
    if (!Array.isArray(keys)) continue

    for (const key of keys) {
      if (isValidIssueKey(key)) {
        uniqueKeys.add(key)
      } else {
        invalid.push(key)
      }
    }
  }

  if (invalid.length > 0) {
    logger.warn('Invalid issue keys filtered out during deduplication', {
      invalid,
      count: invalid.length,
    })
  }

  const result = Array.from(uniqueKeys)
  logger.debug('Issue keys deduplicated', {
    totalUnique: result.length,
    invalidFiltered: invalid.length,
  })

  return result
}

/**
 * Extract PR number from commit message
 * @param {string} commitMessage - Git commit message
 * @returns {string|null} PR number or null if not found
 */
function extractPrNumber (commitMessage) {
  if (!commitMessage) return null

  const prMatch = commitMessage.match(ACTION_CONSTANTS.VALIDATION.PR_NUMBER_PATTERN)
  return prMatch ? prMatch[1] : null
}

/**
 * Fetch commits from GitHub API and extract issue keys, stopping when consecutive
 * tickets are already in "Done" status (smart iteration to handle out-of-band releases)
 *
 * NOTE: Alternative future optimization suggested by Damian:
 * - Store SHA of last successful deployment
 * - Use GitHub API compare endpoint: GET /repos/{owner}/{repo}/compare/{base}...{head}
 * - Only process commits since last deployment
 * - Would be more efficient but requires storing deployment state
 *
 * Current approach prioritizes reliability over speed with:
 * - Batch processing with delays between batches
 * - Smart early termination when consecutive tickets are already in target status
 * - Safety limits to prevent runaway processing
 *
 * @param {Object} octokit - Octokit instance
 * @param {Object} jiraUtil - Jira utility instance
 * @param {string} owner - Repository owner
 * @param {string} repo - Repository name
 * @param {string} branch - Branch name
 * @param {string} targetStatus - Target status to check for (e.g., "Done", "Deployed to Staging")
 * @param {number} consecutiveDoneThreshold - Number of consecutive "done" tickets to stop at (default: 5)
 * @returns {Promise<string[]>} Array of unique issue keys that need updating
 */
async function fetchCommitsAndExtractIssues (octokit, jiraUtil, owner, repo, branch, targetStatus, consecutiveDoneThreshold = 5) {
  const finishOp = logger.startOperation('fetchCommitsAndExtractIssues', {
    owner,
    repo,
    branch,
    targetStatus,
    consecutiveDoneThreshold,
  })

  try {
    logger.info('Fetching commits with smart iteration (stops at consecutive done tickets)', {
      owner,
      repo,
      branch,
      targetStatus,
      consecutiveDoneThreshold,
    })

    const allIssueKeys = []
    let page = 1
    let consecutiveDoneCount = 0
    let totalCommitsChecked = 0
    let shouldContinue = true
    const perPage = 100 // GitHub API max per page

    while (shouldContinue) {
      // Fetch commits page by page
      logger.debug('Fetching commits page', { page, perPage })

      const { data: commits } = await fetchGitHubDataWithRetry(
        async () => octokit.rest.repos.listCommits({
          owner,
          repo,
          sha: branch,
          per_page: perPage,
          page,
        }),
        {}
      )

      if (commits.length === 0) {
        logger.info('No more commits to fetch')
        shouldContinue = false
        break
      }

      totalCommitsChecked += commits.length

      // Extract issue keys from this batch of commits
      const batchIssueKeys = []
      for (const commit of commits) {
        const message = commit.commit.message
        const matches = message.match(ACTION_CONSTANTS.VALIDATION.ISSUE_KEY_EXTRACT_PATTERN)

        if (matches) {
          for (const key of matches) {
            if (isValidIssueKey(key) && !batchIssueKeys.includes(key) && !allIssueKeys.includes(key)) {
              batchIssueKeys.push(key)
            }
          }
        }
      }

      logger.debug('Extracted issues from batch', {
        page,
        commitsInBatch: commits.length,
        issuesInBatch: batchIssueKeys.length,
        issues: batchIssueKeys,
      })

      // Check status of extracted issues in Jira
      if (batchIssueKeys.length > 0) {
        for (const issueKey of batchIssueKeys) {
          try {
            // Fetch issue status from Jira
            const issueResponse = await jiraUtil.request(`/issue/${issueKey}?fields=status`)
            const issueData = await issueResponse.json()
            const currentStatus = issueData.fields.status.name

            logger.debug('Checked issue status', {
              issueKey,
              currentStatus,
              targetStatus,
            })

            if (currentStatus === targetStatus) {
              // Issue is already in target status
              consecutiveDoneCount++
              logger.debug('Issue already in target status', {
                issueKey,
                currentStatus,
                consecutiveDoneCount,
              })

              // Stop if we've found enough consecutive done tickets
              if (consecutiveDoneCount >= consecutiveDoneThreshold) {
                logger.info('Found consecutive tickets already in target status, stopping iteration', {
                  consecutiveDoneCount,
                  threshold: consecutiveDoneThreshold,
                  lastIssue: issueKey,
                })

                finishOp('success', {
                  commitsChecked: totalCommitsChecked,
                  issueKeysFound: allIssueKeys.length,
                  stoppedEarly: true,
                  consecutiveDone: consecutiveDoneCount,
                })

                return allIssueKeys
              }
            } else {
              // Issue is NOT in target status, needs updating
              consecutiveDoneCount = 0 // Reset counter
              allIssueKeys.push(issueKey)
              logger.debug('Issue needs updating', {
                issueKey,
                currentStatus,
                targetStatus,
              })
            }
          } catch (error) {
            // If we can't fetch the issue (doesn't exist, no permission, etc.), skip it
            logger.warn('Could not fetch issue status, skipping', {
              issueKey,
              error: error.message,
            })
            consecutiveDoneCount = 0 // Reset counter on error
          }
        }
      }

      // Move to next page
      page++

      // Safety limit: stop after 1000 commits (10 pages)
      if (totalCommitsChecked >= 1000) {
        logger.warn('Reached safety limit of 1000 commits, stopping iteration')
        shouldContinue = false
        break
      }

      // If this batch had fewer commits than requested, we've reached the end
      if (commits.length < perPage) {
        logger.info('Reached end of commit history')
        shouldContinue = false
        break
      }

      // Add small delay between batches to avoid rate limiting (reliability over speed)
      if (shouldContinue) {
        logger.debug('Waiting 1 second before next batch to avoid rate limits')
        await new Promise(resolve => setTimeout(resolve, 1000))
      }
    }

    finishOp('success', {
      commitsChecked: totalCommitsChecked,
      issueKeysFound: allIssueKeys.length,
      stoppedEarly: false,
    })

    logger.info('Smart iteration completed', {
      commitsChecked: totalCommitsChecked,
      issueKeysFound: allIssueKeys.length,
      issueKeys: allIssueKeys,
    })

    return allIssueKeys
  } catch (error) {
    finishOp('error', { error: error.message })
    logger.error('Failed to fetch commits from GitHub API', {
      owner,
      repo,
      branch,
      error: error.message,
    })
    // Return empty array on error, don't throw
    return []
  }
}

// ============================================================================
// JIRA FIELD PREPARATION
// ============================================================================

/**
 * Prepare fields for Jira transition, converting names to IDs where needed.
 * @param {Object} fields - Fields object with field names and values
 * @param {Object} jiraUtil - Jira utility instance
 * @returns {Promise<Object>} Prepared fields object
 */
async function prepareFields (fields, jiraUtil) {
  const finishOp = logger.startOperation('prepareFields', {
    fieldCount: Object.keys(fields).length,
  })

  const preparedFields = {}

  for (const [ fieldName, fieldValue ] of Object.entries(fields)) {
    // Convert function values to actual values
    const actualValue = typeof fieldValue === 'function' ? fieldValue() : fieldValue

    if (fieldName === 'resolution' && typeof actualValue === 'string') {
      try {
        const resolutions = await jiraUtil.getFieldOptions('resolution')
        const resolution = resolutions.find((r) => r.name === actualValue)
        if (resolution) {
          preparedFields.resolution = { id: resolution.id }
          logger.debug('Resolved resolution field', {
            name: actualValue,
            id: resolution.id,
          })
        } else {
          logger.warn('Resolution not found', { resolution: actualValue })
        }
      } catch (error) {
        logger.error('Failed to get resolution options', {
          error: error.message,
        })
      }
    } else if (fieldName === 'priority' && typeof actualValue === 'string') {
      try {
        const priorities = await jiraUtil.getFieldOptions('priority')
        const priority = priorities.find((p) => p.name === actualValue)
        if (priority) {
          preparedFields.priority = { id: priority.id }
          logger.debug('Resolved priority field', {
            name: actualValue,
            id: priority.id,
          })
        }
      } catch (error) {
        logger.error('Failed to get priority options', {
          error: error.message,
        })
      }
    } else if (fieldName === 'assignee' && typeof actualValue === 'string') {
      preparedFields.assignee = { name: actualValue }
    } else {
      preparedFields[fieldName] = actualValue
    }
  }

  finishOp('success', {
    preparedFieldCount: Object.keys(preparedFields).length,
  })

  return preparedFields
}

/**
 * Prepare custom fields, resolving function values
 * @param {Object} customFields - Custom fields object
 * @returns {Object} Prepared custom fields
 */
function prepareCustomFields (customFields) {
  const prepared = {}

  for (const [ fieldId, fieldValue ] of Object.entries(customFields)) {
    prepared[fieldId] = typeof fieldValue === 'function' ? fieldValue() : fieldValue
  }

  return prepared
}

// ============================================================================
// ISSUE UPDATE FUNCTIONS
// ============================================================================

/**
 * Updates a Jira issue with status transition and custom fields.
 *
 * Performs transition first, then updates custom fields separately to avoid
 * field validation conflicts during transitions.
 *
 * @param {Object} jiraUtil - Jira utility instance
 * @param {string} issueKey - Jira issue key (e.g., "DEX-123")
 * @param {string} targetStatus - Target status name
 * @param {string[]} excludeStates - States to exclude from transition path
 * @param {Object} transitionFields - Fields to include in transition payload
 * @param {Object} customFields - Custom fields to update after transition
 * @returns {Promise<boolean>} True if update successful
 * @throws {Error} If transition or custom field update fails
 */
async function updateIssueWithCustomFields (
  jiraUtil,
  issueKey,
  targetStatus,
  excludeStates,
  transitionFields,
  customFields
) {
  const finishOp = logger.startOperation('updateIssueWithCustomFields', {
    issueKey,
    targetStatus,
  })

  try {
    // Prepare and perform transition
    const preparedTransitionFields = await prepareFields(transitionFields, jiraUtil)

    logger.debug('Transitioning issue', {
      issueKey,
      targetStatus,
      excludeStates,
      transitionFields: preparedTransitionFields,
    })

    await jiraUtil.transitionIssue(
      issueKey,
      targetStatus,
      excludeStates,
      preparedTransitionFields
    )

    // Update custom fields if provided
    if (customFields && Object.keys(customFields).length > 0) {
      const preparedCustomFields = prepareCustomFields(customFields)

      logger.debug('Updating custom fields', {
        issueKey,
        customFields: preparedCustomFields,
      })

      await jiraUtil.updateCustomFields(issueKey, preparedCustomFields)
    }

    finishOp('success')
    logger.info('Issue updated successfully', {
      issueKey,
      targetStatus,
    })

    return true
  } catch (error) {
    finishOp('error', { error: error.message })
    logger.error('Failed to update issue', {
      issueKey,
      targetStatus,
      error: error.message,
      errorType: error.name,
    })
    throw error
  }
}

/**
 * Update multiple issues from commit history with status and custom fields.
 * @param {Object} jiraUtil - Jira utility instance
 * @param {string[]} issueKeys - Array of issue keys to update
 * @param {string} targetStatus - Target status name
 * @param {string[]} excludeStates - States to exclude from transition
 * @param {Object} transitionFields - Fields for transition
 * @param {Object} customFields - Custom fields to update
 * @returns {Promise<Object>} Update results with counts and errors
 */
async function updateIssuesFromCommitHistory (
  jiraUtil,
  issueKeys,
  targetStatus,
  excludeStates,
  transitionFields,
  customFields
) {
  const finishOp = logger.startOperation('updateIssuesFromCommitHistory', {
    issueCount: issueKeys.length,
    targetStatus,
  })

  if (!issueKeys || issueKeys.length === 0) {
    logger.info('No issue keys provided for update')
    finishOp('success', { skipped: true })
    return { successful: 0, failed: 0, errors: [] }
  }

  // Deduplicate issue keys
  const uniqueIssueKeys = deduplicateIssueKeys(issueKeys)

  logger.info('Updating issues from commit history', {
    totalIssues: uniqueIssueKeys.length,
    targetStatus,
  })

  const results = await Promise.allSettled(
    uniqueIssueKeys.map((issueKey) =>
      updateIssueWithCustomFields(
        jiraUtil,
        issueKey,
        targetStatus,
        excludeStates,
        transitionFields,
        customFields
      )
    )
  )

  const successful = results.filter((r) => r.status === 'fulfilled').length
  const failed = results.filter((r) => r.status === 'rejected')
  const errors = failed.map((r) => ({
    message: r.reason?.message || 'Unknown error',
    issueKey: r.reason?.issueKey,
  }))

  finishOp('success', {
    successful,
    failed: failed.length,
  })

  logger.info('Commit history update completed', {
    successful,
    failed: failed.length,
    total: uniqueIssueKeys.length,
  })

  if (failed.length > 0) {
    logger.warn('Some updates failed', {
      failedCount: failed.length,
      errors: errors.slice(0, 5), // Log first 5 errors
    })
  }

  return {
    successful,
    failed: failed.length,
    errors,
  }
}

/**
 * Update issues by PR URL search with status and custom fields.
 * @param {Object} jiraUtil - Jira utility instance
 * @param {string} prUrl - Pull request URL to search for
 * @param {string} targetStatus - Target status name
 * @param {Object} transitionFields - Fields for transition
 * @param {Object} customFields - Custom fields to update
 * @returns {Promise<number>} Number of issues updated
 * @throws {Error} If JQL search or update fails
 */
async function updateIssuesByPR (
  jiraUtil,
  prUrl,
  targetStatus,
  transitionFields,
  customFields
) {
  const finishOp = logger.startOperation('updateIssuesByPR', {
    prUrl,
    targetStatus,
  })

  try {
    const jql = `text ~ "${prUrl}"`
    logger.debug('Searching for issues by PR URL', { prUrl, jql })

    const response = await jiraUtil.request('/search/jql', {
      method: 'POST',
      body: JSON.stringify({
        jql,
        fields: [ 'key', 'summary', 'status', 'description' ],
        maxResults: ACTION_CONSTANTS.GITHUB_API.MAX_RESULTS,
      }),
    })

    const data = await response.json()
    const issues = data.issues || []

    logger.info('Found issues mentioning PR', {
      prUrl,
      issueCount: issues.length,
    })

    if (issues.length === 0) {
      finishOp('success', { issuesFound: 0 })
      return 0
    }

    const issueKeys = issues.map(issue => issue.key)
    const updateResults = await updateIssuesFromCommitHistory(
      jiraUtil,
      issueKeys,
      targetStatus,
      ACTION_CONSTANTS.EXCLUDED_STATES,
      transitionFields,
      customFields
    )

    finishOp('success', {
      issuesFound: issues.length,
      successful: updateResults.successful,
      failed: updateResults.failed,
    })

    return issues.length
  } catch (error) {
    finishOp('error', { error: error.message })
    logger.error('Error updating issues by PR', {
      prUrl,
      error: error.message,
    })
    throw error
  }
}

// ============================================================================
// GITHUB API HELPERS
// ============================================================================

/**
 * Fetch GitHub data with retry logic for rate limiting
 * @param {Function} operation - Async operation to perform
 * @param {Object} params - Operation parameters
 * @param {number} [retryCount=0] - Current retry attempt
 * @returns {Promise<*>} Operation result
 * @throws {GitHubApiError} If all retries fail
 */
async function fetchGitHubDataWithRetry (operation, params, retryCount = 0) {
  try {
    return await operation(params)
  } catch (error) {
    // Handle rate limiting
    if (error.status === 429 && retryCount < ACTION_CONSTANTS.RETRY.MAX_ATTEMPTS) {
      const retryAfter = parseInt(error.response?.headers['retry-after'] || '60', 10)
      const delay = retryAfter * 1000

      logger.warn('GitHub rate limit hit, retrying', {
        retryAfter,
        retryCount,
        nextRetryIn: delay,
      })

      await sleep(delay)
      return fetchGitHubDataWithRetry(operation, params, retryCount + 1)
    }

    // Handle server errors with exponential backoff
    if (error.status >= 500 && retryCount < ACTION_CONSTANTS.RETRY.MAX_ATTEMPTS) {
      const delay = ACTION_CONSTANTS.RETRY.BASE_DELAY_MS *
        Math.pow(ACTION_CONSTANTS.RETRY.BACKOFF_MULTIPLIER, retryCount)

      logger.warn('GitHub server error, retrying', {
        status: error.status,
        retryCount,
        nextRetryIn: delay,
      })

      await sleep(delay)
      return fetchGitHubDataWithRetry(operation, params, retryCount + 1)
    }

    throw new GitHubApiError(
      `GitHub API error: ${error.message}`,
      error.status || 0,
      'fetchGitHubData'
    )
  }
}

// ============================================================================
// EVENT HANDLERS
// ============================================================================

/**
 * Handle pull request events (open, close, synchronize, etc).
 * @param {Object} eventData - GitHub event payload
 * @param {Object} jiraUtil - Jira utility instance
 * @returns {Promise<void>}
 */
async function handlePullRequestEvent (eventData, jiraUtil) {
  const finishOp = logger.startOperation('handlePullRequestEvent', {
    action: eventData.action,
    prNumber: eventData.pull_request?.number,
  })

  try {
    const { action, pull_request } = eventData

    // Extract issue keys from PR
    const issueKeys = extractJiraIssueKeys(pull_request)

    if (issueKeys.length === 0) {
      logger.info('No Jira issue keys found in PR', {
        prNumber: pull_request.number,
        prTitle: pull_request.title,
      })
      finishOp('success', { issueKeysFound: 0, skipped: true })
      return
    }

    logger.info('Processing PR event', {
      action,
      prNumber: pull_request.number,
      issueKeys,
      targetBranch: pull_request.base.ref,
    })

    let targetStatus = null
    let transitionFields = {}
    let customFields = {}
    const targetBranch = pull_request.base.ref

    // Determine target status based on PR action
    switch (action) {
      case ACTION_CONSTANTS.PR_ACTIONS.OPENED:
      case ACTION_CONSTANTS.PR_ACTIONS.REOPENED:
      case ACTION_CONSTANTS.PR_ACTIONS.READY_FOR_REVIEW:
        targetStatus = ACTION_CONSTANTS.JIRA_STATUSES.CODE_REVIEW
        break

      case ACTION_CONSTANTS.PR_ACTIONS.CONVERTED_TO_DRAFT:
        targetStatus = ACTION_CONSTANTS.JIRA_STATUSES.IN_DEVELOPMENT
        break

      case ACTION_CONSTANTS.PR_ACTIONS.SYNCHRONIZE:
        if (!pull_request.draft) {
          targetStatus = ACTION_CONSTANTS.JIRA_STATUSES.CODE_REVIEW
        }
        break

      case ACTION_CONSTANTS.PR_ACTIONS.CLOSED:
        if (pull_request.merged) {
          const branchConfig = STATUS_MAP[targetBranch]
          if (branchConfig) {
            targetStatus = branchConfig.status
            transitionFields = branchConfig.transitionFields || {}
            customFields = branchConfig.customFields || {}
          } else {
            logger.warn('No status mapping for target branch, using default', {
              targetBranch,
            })
            targetStatus = ACTION_CONSTANTS.JIRA_STATUSES.DONE
            transitionFields = { resolution: 'Done' }
          }
        } else {
          logger.info('PR closed without merging, skipping status update', {
            prNumber: pull_request.number,
          })
          finishOp('success', { skipped: true, reason: 'not_merged' })
          return
        }
        break

      default:
        logger.info('No status updates for PR action', { action })
        finishOp('success', { skipped: true, reason: 'unsupported_action' })
        return
    }

    if (!targetStatus) {
      logger.debug('No target status determined', { action })
      finishOp('success', { skipped: true })
      return
    }

    // Update all issues
    const failedUpdates = []
    for (const issueKey of issueKeys) {
      try {
        await updateIssueWithCustomFields(
          jiraUtil,
          issueKey,
          targetStatus,
          ACTION_CONSTANTS.EXCLUDED_STATES,
          transitionFields,
          customFields
        )
      } catch (error) {
        logger.error('Failed to update issue from PR event', {
          issueKey,
          targetStatus,
          action,
          prNumber: pull_request.number,
          error: error.message,
        })
        failedUpdates.push({ issueKey, error: error.message })
      }
    }

    finishOp('success', {
      issuesProcessed: issueKeys.length,
      successful: issueKeys.length - failedUpdates.length,
      failed: failedUpdates.length,
    })

    logger.info('PR event processing completed', {
      action,
      prNumber: pull_request.number,
      issuesProcessed: issueKeys.length,
      successful: issueKeys.length - failedUpdates.length,
      failed: failedUpdates.length,
    })
  } catch (error) {
    finishOp('error', { error: error.message })
    throw error
  }
}

/**
 * Handle push events to branches (deployment tracking).
 * @param {string} branch - Branch name
 * @param {Object} jiraUtil - Jira utility instance
 * @param {string} githubRepository - Repository in "owner/repo" format
 * @param {string} githubToken - GitHub API token
 * @returns {Promise<void>}
 */
async function handlePushEvent (branch, jiraUtil, githubRepository, githubToken) {
  const finishOp = logger.startOperation('handlePushEvent', {
    branch,
    repository: githubRepository,
  })

  try {
    const { owner, repo } = parseRepository(githubRepository)

    // Get branch configuration
    const branchConfig = STATUS_MAP[branch]
    if (!branchConfig) {
      logger.warn('No status mapping for branch, skipping', { branch })
      finishOp('success', { skipped: true, reason: 'no_config' })
      return
    }

    const targetStatus = branchConfig.status
    const transitionFields = branchConfig.transitionFields || {}
    const customFields = branchConfig.customFields || {}

    logger.info('Processing push event', {
      branch,
      targetStatus,
      repository: githubRepository,
    })

    // Initialize Octokit
    const octokit = new Octokit({ auth: githubToken })

    // Get latest commit
    const { data } = await fetchGitHubDataWithRetry(
      async () => octokit.rest.repos.getCommit({
        owner,
        repo,
        ref: branch,
      }),
      {}
    )

    const commitMessage = data.commit.message
    logger.debug('Latest commit retrieved', {
      sha: data.sha.substring(0, 7),
      message: commitMessage.split('\n')[0],
    })

    const prNumber = extractPrNumber(commitMessage)

    // Handle production deployments (master/main)
    if (ACTION_CONSTANTS.BRANCHES.PRODUCTION.includes(branch)) {
      logger.info('Production deployment detected', { branch })

      try {
        // Smart iteration: fetch commits and stop when we find 5 consecutive tickets already in "Done"
        const commitHistoryIssues = await fetchCommitsAndExtractIssues(
          octokit,
          jiraUtil,
          owner,
          repo,
          branch,
          targetStatus, // "Done"
          5 // Stop after 5 consecutive "Done" tickets
        )

        if (commitHistoryIssues.length > 0) {
          logger.info('Found issues in production commit history', {
            issueCount: commitHistoryIssues.length,
            issueKeys: commitHistoryIssues,
          })

          // For production: ONLY update custom fields, Jira automation handles status transition
          // Setting Production Release Timestamp + Release Environment triggers auto-transition to Done
          const preparedCustomFields = prepareCustomFields(customFields)

          logger.info('Updating production custom fields (Jira automation will handle status transition)', {
            issueCount: commitHistoryIssues.length,
            fields: Object.keys(preparedCustomFields),
          })

          const results = await Promise.allSettled(
            commitHistoryIssues.map((issueKey) =>
              jiraUtil.updateCustomFields(issueKey, preparedCustomFields)
            )
          )

          const successful = results.filter((r) => r.status === 'fulfilled').length
          const failed = results.filter((r) => r.status === 'rejected')

          logger.info('Production deployment completed', {
            successful,
            failed: failed.length,
            issueKeys: commitHistoryIssues,
          })

          if (failed.length > 0) {
            logger.warn('Some production updates failed', {
              failedCount: failed.length,
              errors: failed.map(r => r.reason?.message).slice(0, 5),
            })
          }
        } else {
          logger.info('No Jira issues found in production commit history')
        }
      } catch (error) {
        logger.error('Error processing production commit history', {
          error: error.message,
        })
      }

      // Also handle direct PR merges to production
      if (prNumber) {
        const prUrl = constructPrUrl(owner, repo, prNumber)
        logger.info('Processing direct PR merge to production', { prUrl })

        try {
          // Search for issues mentioning this PR
          const jql = `text ~ "${prUrl}"`
          const response = await jiraUtil.request('/search', {
            method: 'POST',
            body: JSON.stringify({
              jql,
              fields: [ 'key', 'summary', 'status' ],
              maxResults: ACTION_CONSTANTS.GITHUB_API.MAX_RESULTS,
            }),
          })

          const data = await response.json()
          const issues = data.issues || []

          if (issues.length > 0) {
            logger.info('Found issues for PR in production', {
              prUrl,
              issueCount: issues.length,
              issueKeys: issues.map(i => i.key),
            })

            // For production: ONLY update custom fields
            const preparedCustomFields = prepareCustomFields(customFields)

            const results = await Promise.allSettled(
              issues.map((issue) =>
                jiraUtil.updateCustomFields(issue.key, preparedCustomFields)
              )
            )

            const successful = results.filter((r) => r.status === 'fulfilled').length
            const failed = results.filter((r) => r.status === 'rejected')

            logger.info('Production PR updates completed', {
              prUrl,
              successful,
              failed: failed.length,
            })
          } else {
            logger.info('No issues found for PR', { prUrl })
          }
        } catch (error) {
          logger.error('Error updating issues from PR to production', {
            prUrl,
            error: error.message,
          })
        }
      }

      finishOp('success', { branch, type: 'production' })
      return
    }

    // Handle staging deployments
    if (branch === ACTION_CONSTANTS.BRANCHES.STAGING) {
      logger.info('Staging deployment detected', { branch })

      try {
        // Smart iteration: fetch commits and stop when we find 5 consecutive tickets already in "Deployed to Staging"
        const commitHistoryIssues = await fetchCommitsAndExtractIssues(
          octokit,
          jiraUtil,
          owner,
          repo,
          branch,
          targetStatus, // "Deployed to Staging"
          5 // Stop after 5 consecutive "Deployed to Staging" tickets
        )

        if (commitHistoryIssues.length > 0) {
          logger.info('Found issues in staging commit history', {
            issueCount: commitHistoryIssues.length,
          })

          const updateResults = await updateIssuesFromCommitHistory(
            jiraUtil,
            commitHistoryIssues,
            targetStatus,
            ACTION_CONSTANTS.EXCLUDED_STATES,
            transitionFields,
            customFields
          )

          logger.info('Staging deployment completed', {
            successful: updateResults.successful,
            failed: updateResults.failed,
          })

          finishOp('success', {
            branch,
            type: 'staging',
            issuesUpdated: updateResults.successful,
          })
          return
        } else {
          logger.info('No Jira issues found in staging commit history')
        }
      } catch (error) {
        logger.error('Error processing staging commit history', {
          error: error.message,
        })
      }

      // Also handle direct PR merges to staging
      if (prNumber) {
        const prUrl = constructPrUrl(owner, repo, prNumber)
        logger.info('Processing direct PR merge to staging', { prUrl })

        try {
          await updateIssuesByPR(
            jiraUtil,
            prUrl,
            targetStatus,
            transitionFields,
            customFields
          )
        } catch (error) {
          logger.error('Error updating issues from PR to staging', {
            prUrl,
            error: error.message,
          })
        }
      }

      finishOp('success', { branch, type: 'staging' })
      return
    }

    // Handle other branch merges (like dev)
    if (prNumber) {
      const prUrl = constructPrUrl(owner, repo, prNumber)
      logger.info('Processing PR merge', { branch, prUrl })

      try {
        await updateIssuesByPR(
          jiraUtil,
          prUrl,
          targetStatus,
          transitionFields,
          customFields
        )
        finishOp('success', { branch, type: 'pr_merge', prUrl })
      } catch (error) {
        logger.error('Error updating issues from PR', {
          prUrl,
          error: error.message,
        })
        finishOp('error', { error: error.message })
      }
    } else {
      logger.info('No PR number found in commit message', { branch })
      finishOp('success', { skipped: true, reason: 'no_pr_number' })
    }
  } catch (error) {
    finishOp('error', { error: error.message })
    logger.error('Error in handlePushEvent', {
      branch,
      error: error.message,
    })
    throw error
  }
}

// ============================================================================
// EVENT ROUTER
// ============================================================================

/**
 * Route event to appropriate handler based on event type.
 * @param {string} eventType - GitHub event type
 * @param {Object} eventData - Event payload
 * @param {Object} context - Execution context
 * @returns {Promise<void>}
 */
async function routeEvent (eventType, eventData, context) {
  const finishOp = logger.startOperation('routeEvent', {
    eventType,
    dryRun: context.dryRun,
  })

  try {
    // Validate event data
    validateEventData(eventData, eventType)

    // Check dry run mode
    if (context.dryRun) {
      logger.info('DRY RUN: Skipping actual Jira updates', { eventType })
      finishOp('success', { dryRun: true })
      return
    }

    // Route to appropriate handler
    if (eventType === ACTION_CONSTANTS.GITHUB_ACTIONS.PULL_REQUEST ||
        eventType === ACTION_CONSTANTS.GITHUB_ACTIONS.PULL_REQUEST_TARGET) {
      await handlePullRequestEvent(
        eventData,
        context.jiraUtil
      )
    } else if (eventType === ACTION_CONSTANTS.GITHUB_ACTIONS.PUSH) {
      // Extract branch name from ref
      const branchName = context.githubRef.split('/').pop()
      await handlePushEvent(
        branchName,
        context.jiraUtil,
        context.githubRepository,
        context.githubToken
      )
    } else {
      logger.warn('No handler for event type', { eventType })
    }

    finishOp('success')
  } catch (error) {
    finishOp('error', { error: error.message })
    throw error
  }
}

// ============================================================================
// EVENT LOADING
// ============================================================================

/**
 * Load event data from file system
 * @param {string} eventPath - Path to event file
 * @param {string} environment - Runtime environment
 * @returns {Object|null} Event data or null if not available
 */
function loadEventData (eventPath, environment) {
  const finishOp = logger.startOperation('loadEventData', {
    environment,
  })

  try {
    // Local environment - check for override file first
    if (environment === 'local') {
      const localEventPath = './update_jira/event.local.json'
      if (fs.existsSync(localEventPath)) {
        logger.info('Loading local event override', { path: localEventPath })
        const data = JSON.parse(fs.readFileSync(localEventPath, 'utf8'))
        finishOp('success', { source: 'local_override' })
        return data
      }
    }

    // Load from GITHUB_EVENT_PATH
    if (eventPath && fs.existsSync(eventPath)) {
      logger.info('Loading event from GITHUB_EVENT_PATH', { path: eventPath })
      const data = JSON.parse(fs.readFileSync(eventPath, 'utf8'))
      finishOp('success', { source: 'github_event_path' })
      return data
    }

    logger.debug('No event data file found')
    finishOp('success', { source: 'none' })
    return null
  } catch (error) {
    finishOp('error', { error: error.message })
    logger.error('Error loading event data', {
      eventPath,
      error: error.message,
    })
    throw new EventProcessingError(
      `Failed to load event data: ${error.message}`,
      'unknown',
      null
    )
  }
}

// ============================================================================
// MAIN EXECUTION
// ============================================================================

/**
 * Log environment and startup information
 */
function logStartupInfo (config) {
  logger.info('='.repeat(50))
  logger.info('GitHub Actions: Jira Integration')
  logger.info('='.repeat(50))
  logger.info('Environment Information', {
    environment: config.environment,
    githubRef: config.github.ref,
    githubEventName: config.github.eventName,
    githubRepository: config.github.repository,
    jiraBaseUrl: config.jira.baseUrl,
    dryRun: config.dryRun,
  })
  logger.info('='.repeat(50))
}

/**
 * Main execution function
 * @returns {Promise<void>}
 */
async function run () {
  const finishOp = logger.startOperation('run')

  try {
    // Load and validate configuration
    const config = loadAndValidateConfiguration()

    // Log startup info
    logStartupInfo(config)

    // Initialize Jira utility
    logger.debug('Initializing Jira utility')
    const jiraUtil = new Jira({
      baseUrl: config.jira.baseUrl,
      email: config.jira.email,
      apiToken: config.jira.apiToken,
      logLevel: config.jira.logLevel,
    })
    logger.info('Jira utility initialized successfully')

    // Load event data
    const eventData = loadEventData(
      config.github.eventPath,
      config.environment
    )

    if (!eventData) {
      logger.warn('No event data available, cannot process event')
      finishOp('success', { skipped: true, reason: 'no_event_data' })
      return
    }

    // Create execution context
    const context = {
      jiraUtil,
      githubRepository: config.github.repository,
      githubToken: config.github.token,
      githubRef: config.github.ref,
      dryRun: config.dryRun,
    }

    // Route event to appropriate handler
    if (config.github.eventName === ACTION_CONSTANTS.GITHUB_ACTIONS.PULL_REQUEST ||
        config.github.eventName === ACTION_CONSTANTS.GITHUB_ACTIONS.PULL_REQUEST_TARGET) {
      await routeEvent(config.github.eventName, eventData, context)
    } else if (ACTION_CONSTANTS.BRANCHES.ALLOWED_REFS.includes(config.github.ref)) {
      // Push event
      await routeEvent(ACTION_CONSTANTS.GITHUB_ACTIONS.PUSH, eventData, context)
    } else {
      logger.info('Event not applicable for Jira updates', {
        eventName: config.github.eventName,
        ref: config.github.ref,
      })
    }

    finishOp('success')
    logger.info('Action completed successfully')
  } catch (error) {
    finishOp('error', { error: error.message })
    logger.error('Action failed', {
      error: error.message,
      errorType: error.name,
      stack: error.stack,
    })
    core.setFailed(error.message)
  }
}

// ============================================================================
// EXPORTS
// ============================================================================

module.exports = Object.assign(module.exports || {}, {
  // For testing
  detectEnvironment,
  extractJiraIssueKeys,
  extractPrNumber,
  deduplicateIssueKeys,
  constructPrUrl,
  parseRepository,
  isValidIssueKey,
  // Error classes
  GitHubActionError,
  EventProcessingError,
  ConfigurationError,
  GitHubApiError,
})

// ============================================================================
// STARTUP
// ============================================================================

// Execute if run directly (not imported)
if (require.main === module) {
  run()
}
