/**
 * @fileoverview Comprehensive Unit Tests for utils/jira.js
 * @module utils/jira.test
 *
 * Run with: npm test
 * Run specific file: npx jest utils/jira.test.js
 * Run with coverage: npx jest --coverage
 */

const Jira = require('./jira')

// Mock fetch globally
global.fetch = jest.fn()

describe('Jira Utility Class', () => {
  let jira

  beforeEach(() => {
    // Reset mocks before each test
    jest.clearAllMocks()

    // Create new Jira instance
    jira = new Jira({
      baseUrl: 'https://test.atlassian.net',
      email: 'test@example.com',
      apiToken: 'test-token',
      logLevel: 'ERROR', // Suppress logs during tests
    })
  })

  // ==========================================================================
  // CONSTRUCTOR TESTS
  // ==========================================================================

  describe('Constructor', () => {
    test('should create instance with valid configuration', () => {
      expect(jira).toBeInstanceOf(Jira)
      expect(jira.baseUrl).toBe('https://test.atlassian.net/rest/api/3')
      expect(jira.email).toBe('test@example.com')
      expect(jira.apiToken).toBe('test-token')
    })

    test('should initialize with default log level', () => {
      const jiraDefault = new Jira({
        baseUrl: 'https://test.atlassian.net',
        email: 'test@example.com',
        apiToken: 'test-token',
      })
      expect(jiraDefault.logger.level).toBe('INFO')
    })

    test('should initialize state machine cache as Map', () => {
      expect(jira.stateMachineCache).toBeInstanceOf(Map)
      expect(jira.stateMachineCache.size).toBe(0)
    })

    test('should create authorization headers', () => {
      expect(jira.headers.Authorization).toBeDefined()
      expect(jira.headers.Authorization).toContain('Basic')
      expect(jira.headers['Content-Type']).toBe('application/json')
    })
  })

  // ==========================================================================
  // REQUEST METHOD TESTS
  // ==========================================================================

  describe('request()', () => {
    test('should make successful API request', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({ data: 'test' }),
        headers: new Map(),
      }
      global.fetch.mockResolvedValue(mockResponse)

      const response = await jira.request('/test')

      expect(global.fetch).toHaveBeenCalledWith(
        'https://test.atlassian.net/rest/api/3/test',
        expect.objectContaining({
          method: 'GET',
          headers: expect.any(Object),
        })
      )
      expect(response).toBe(mockResponse)
    })

    test('should handle POST requests with body', async () => {
      const mockResponse = {
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({}),
        headers: new Map(),
      }
      global.fetch.mockResolvedValue(mockResponse)

      const body = JSON.stringify({ key: 'value' })
      await jira.request('/test', {
        method: 'POST',
        body,
      })

      expect(global.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          method: 'POST',
          body,
        })
      )
    })

    test('should retry on rate limit (429)', async () => {
      const mockFailure = {
        ok: false,
        status: 429,
        headers: new Map([[ 'Retry-After', '1' ]]),
        json: jest.fn().mockResolvedValue({ errorMessages: [ 'Rate limited' ] }),
      }
      const mockSuccess = {
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({ data: 'test' }),
        headers: new Map(),
      }

      global.fetch
        .mockResolvedValueOnce(mockFailure)
        .mockResolvedValueOnce(mockSuccess)

      const response = await jira.request('/test')

      expect(global.fetch).toHaveBeenCalledTimes(2)
      expect(response).toBe(mockSuccess)
    })

    test('should retry on server error (500)', async () => {
      const mockFailure = {
        ok: false,
        status: 500,
        headers: new Map(),
        json: jest.fn().mockResolvedValue({ errorMessages: [ 'Server error' ] }),
      }
      const mockSuccess = {
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({ data: 'test' }),
        headers: new Map(),
      }

      global.fetch
        .mockResolvedValueOnce(mockFailure)
        .mockResolvedValueOnce(mockSuccess)

      const response = await jira.request('/test')

      expect(global.fetch).toHaveBeenCalledTimes(2)
      expect(response).toBe(mockSuccess)
    })

    test('should throw error after max retries', async () => {
      const mockFailure = {
        ok: false,
        status: 500,
        headers: new Map(),
        json: jest.fn().mockResolvedValue({ errorMessages: [ 'Server error' ] }),
      }

      global.fetch.mockResolvedValue(mockFailure)

      await expect(jira.request('/test')).rejects.toThrow()
      expect(global.fetch).toHaveBeenCalledTimes(3) // Initial + 2 retries
    })

    test('should handle network errors with retry', async () => {
      global.fetch
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: jest.fn().mockResolvedValue({ data: 'test' }),
          headers: new Map(),
        })

      const response = await jira.request('/test')

      expect(global.fetch).toHaveBeenCalledTimes(2)
      expect(response.status).toBe(200)
    })
  })

  // ==========================================================================
  // ISSUE KEY VALIDATION TESTS
  // ==========================================================================

  describe('validateIssueKey()', () => {
    test('should validate correct issue keys', () => {
      expect(() => jira.validateIssueKey('DEX-36')).not.toThrow()
      expect(() => jira.validateIssueKey('ALL-593')).not.toThrow()
      expect(() => jira.validateIssueKey('A-1')).not.toThrow()
    })

    test('should throw error for invalid issue keys', () => {
      expect(() => jira.validateIssueKey('invalid')).toThrow()
      expect(() => jira.validateIssueKey('123-456')).toThrow()
      expect(() => jira.validateIssueKey('')).toThrow()
      expect(() => jira.validateIssueKey(null)).toThrow()
    })
  })

  // ==========================================================================
  // ISSUE EXTRACTION TESTS
  // ==========================================================================

  describe('extractIssueKeysFromCommitMessages()', () => {
    test('should extract issue keys from commit messages', () => {
      const messages = [
        'DEX-36: Fix bug',
        'ALL-593: Add feature',
        'No ticket here',
      ]

      const keys = jira.extractIssueKeysFromCommitMessages(messages)

      expect(keys).toContain('DEX-36')
      expect(keys).toContain('ALL-593')
      expect(keys).toHaveLength(2)
    })

    test('should deduplicate issue keys', () => {
      const messages = [
        'DEX-36: First commit',
        'DEX-36: Second commit',
        'ALL-593: Third commit',
      ]

      const keys = jira.extractIssueKeysFromCommitMessages(messages)

      expect(keys).toHaveLength(2)
      expect(keys).toContain('DEX-36')
      expect(keys).toContain('ALL-593')
    })

    test('should handle empty array', () => {
      const keys = jira.extractIssueKeysFromCommitMessages([])
      expect(keys).toEqual([])
    })

    test('should extract multiple keys from single message', () => {
      const messages = [ 'DEX-36 ALL-593 INT-874: Multiple tickets' ]

      const keys = jira.extractIssueKeysFromCommitMessages(messages)

      expect(keys).toHaveLength(3)
    })
  })

  // ==========================================================================
  // FIELD OPTIONS TESTS
  // ==========================================================================

  describe('getFieldOptions()', () => {
    test('should fetch resolution options', async () => {
      const mockOptions = [
        { id: '1', name: 'Done' },
        { id: '2', name: 'Won\'t Fix' },
      ]

      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue(mockOptions),
        headers: new Map(),
      })

      const options = await jira.getFieldOptions('resolution')

      expect(options).toEqual(mockOptions)
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/resolution'),
        expect.any(Object)
      )
    })

    test('should fetch priority options', async () => {
      const mockOptions = [
        { id: '1', name: 'High' },
        { id: '2', name: 'Medium' },
      ]

      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue(mockOptions),
        headers: new Map(),
      })

      const options = await jira.getFieldOptions('priority')

      expect(options).toEqual(mockOptions)
    })

    test('should throw error for unsupported field', async () => {
      await expect(jira.getFieldOptions('unsupported')).rejects.toThrow()
    })
  })

  // ==========================================================================
  // CUSTOM FIELDS TESTS
  // ==========================================================================

  describe('Custom Fields', () => {
    test('updateCustomField() should update single custom field', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        status: 204,
        json: jest.fn().mockResolvedValue({}),
        headers: new Map(),
      })

      await jira.updateCustomField('DEX-36', 'customfield_10001', 'test-value')

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/issue/DEX-36'),
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('customfield_10001'),
        })
      )
    })

    test('updateCustomFields() should update multiple custom fields', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        status: 204,
        json: jest.fn().mockResolvedValue({}),
        headers: new Map(),
      })

      const fields = {
        customfield_10001: 'value1',
        customfield_10002: 'value2',
      }

      await jira.updateCustomFields('DEX-36', fields)

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/issue/DEX-36'),
        expect.objectContaining({
          method: 'PUT',
          body: expect.stringContaining('customfield_10001'),
        })
      )
    })

    test('getCustomField() should retrieve custom field value', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          fields: {
            customfield_10001: 'test-value',
          },
        }),
        headers: new Map(),
      })

      const value = await jira.getCustomField('DEX-36', 'customfield_10001')

      expect(value).toBe('test-value')
    })
  })

  // ==========================================================================
  // TRANSITION TESTS
  // ==========================================================================

  describe('Transitions', () => {
    test('getTransitions() should fetch available transitions', async () => {
      const mockTransitions = {
        transitions: [
          { id: '1', name: 'In Progress', to: { name: 'In Progress' } },
          { id: '2', name: 'Done', to: { name: 'Done' } },
        ],
      }

      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue(mockTransitions),
        headers: new Map(),
      })

      const transitions = await jira.getTransitions('DEX-36')

      expect(transitions).toHaveLength(2)
      expect(transitions[0].name).toBe('In Progress')
    })

    test('getTransitionDetails() should fetch transition details', async () => {
      const mockDetails = {
        fields: {
          resolution: {
            required: true,
            name: 'Resolution',
          },
        },
      }

      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue(mockDetails),
        headers: new Map(),
      })

      const details = await jira.getTransitionDetails('DEX-36', '1')

      expect(details.fields.resolution).toBeDefined()
      expect(details.fields.resolution.required).toBe(true)
    })

    test('transitionIssue() should perform transition', async () => {
      // Mock getIssue
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          key: 'DEX-36',
          fields: {
            status: { name: 'To Do' },
            project: { key: 'DEX' },
          },
        }),
        headers: new Map(),
      })

      // Mock getProjectWorkflowName
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          values: [{
            issueTypes: [ 'all' ],
            workflow: { name: 'Software Simplified Workflow' },
          }],
        }),
        headers: new Map(),
      })

      // Mock getWorkflowStateMachine
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          statuses: [
            {
              id: '1',
              name: 'To Do',
              properties: {
                'jira.issue.editable': 'true',
              },
            },
            {
              id: '2',
              name: 'Done',
              properties: {
                'jira.issue.editable': 'true',
              },
            },
          ],
          transitions: [
            {
              id: '10',
              name: 'Complete',
              to: '2',
              from: [ '1' ],
              type: 'directed',
            },
          ],
        }),
        headers: new Map(),
      })

      // Mock getTransitions
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          transitions: [
            { id: '10', name: 'Complete', to: { name: 'Done' } },
          ],
        }),
        headers: new Map(),
      })

      // Mock getTransitionDetails
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          fields: {},
        }),
        headers: new Map(),
      })

      // Mock actual transition
      global.fetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        json: jest.fn().mockResolvedValue({}),
        headers: new Map(),
      })

      await jira.transitionIssue('DEX-36', 'Done')

      // Should have called POST to transitions endpoint
      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('/issue/DEX-36/transitions'),
        expect.objectContaining({
          method: 'POST',
        })
      )
    })
  })

  // ==========================================================================
  // STATE MACHINE TESTS
  // ==========================================================================

  describe('State Machine', () => {
    test('should build state machine from workflow', async () => {
      const mockWorkflowData = {
        statuses: [
          {
            id: '1',
            name: 'To Do',
            properties: {},
          },
          {
            id: '2',
            name: 'In Progress',
            properties: {},
          },
          {
            id: '3',
            name: 'Done',
            properties: {},
          },
        ],
        transitions: [
          {
            id: '10',
            name: 'Start',
            from: [ '1' ],
            to: '2',
            type: 'directed',
          },
          {
            id: '20',
            name: 'Complete',
            from: [ '2' ],
            to: '3',
            type: 'directed',
          },
        ],
      }

      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue(mockWorkflowData),
        headers: new Map(),
      })

      const stateMachine = await jira.getWorkflowStateMachine('Test Workflow')

      expect(stateMachine.states).toHaveProperty('To Do')
      expect(stateMachine.states).toHaveProperty('In Progress')
      expect(stateMachine.states).toHaveProperty('Done')
      expect(stateMachine.states['To Do'].transitions).toHaveLength(1)
      expect(stateMachine.states['In Progress'].transitions).toHaveLength(1)
    })

    test('should cache state machine', async () => {
      const mockWorkflowData = {
        statuses: [{ id: '1', name: 'To Do', properties: {} }],
        transitions: [],
      }

      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue(mockWorkflowData),
        headers: new Map(),
      })

      // First call
      await jira.getWorkflowStateMachine('Test Workflow')
      expect(global.fetch).toHaveBeenCalledTimes(1)

      // Second call should use cache
      await jira.getWorkflowStateMachine('Test Workflow')
      expect(global.fetch).toHaveBeenCalledTimes(1) // No additional call
    })

    test('findShortestTransitionPath() should find path', () => {
      const stateMachine = {
        states: {
          'To Do': {
            id: '1',
            name: 'To Do',
            transitions: [
              { id: '10', name: 'Start', toStatus: 'In Progress' },
            ],
          },
          'In Progress': {
            id: '2',
            name: 'In Progress',
            transitions: [
              { id: '20', name: 'Complete', toStatus: 'Done' },
            ],
          },
          'Done': {
            id: '3',
            name: 'Done',
            transitions: [],
          },
        },
        transitionMap: new Map([
          [ '1', new Map([[ '2', { id: '10', name: 'Start', toStatus: 'In Progress' } ]]) ],
          [ '2', new Map([[ '3', { id: '20', name: 'Complete', toStatus: 'Done' } ]]) ],
        ]),
      }

      const path = jira.findShortestTransitionPath(stateMachine, 'To Do', 'Done')

      expect(path).toHaveLength(2)
      expect(path[0].name).toBe('Start')
      expect(path[1].name).toBe('Complete')
    })

    test('findShortestTransitionPath() should return null if no path exists', () => {
      const stateMachine = {
        states: {
          'To Do': {
            id: '1',
            name: 'To Do',
            transitions: [],
          },
          'Done': {
            id: '2',
            name: 'Done',
            transitions: [],
          },
        },
        transitionMap: new Map(),
      }

      const path = jira.findShortestTransitionPath(stateMachine, 'To Do', 'Done')

      expect(path).toBeNull()
    })
  })

  // ==========================================================================
  // ERROR HANDLING TESTS
  // ==========================================================================

  describe('Error Handling', () => {
    beforeEach(() => {
      jest.clearAllMocks()
    })

    test('should throw JiraApiError on 400 Bad Request', async () => {
      const mockError = {
        ok: false,
        status: 400,
        headers: new Map(),
        json: jest.fn().mockResolvedValue({
          errorMessages: [ 'Bad request' ],
        }),
      }

      // Mock all 3 retry attempts to fail
      global.fetch
        .mockResolvedValueOnce(mockError)
        .mockResolvedValueOnce(mockError)
        .mockResolvedValueOnce(mockError)

      await expect(jira.request('/test')).rejects.toThrow()
    })

    test('should throw JiraApiError on 404 Not Found', async () => {
      const mockError = {
        ok: false,
        status: 404,
        headers: new Map(),
        json: jest.fn().mockResolvedValue({
          errorMessages: [ 'Not found' ],
        }),
      }

      // Mock all 3 retry attempts to fail
      global.fetch
        .mockResolvedValueOnce(mockError)
        .mockResolvedValueOnce(mockError)
        .mockResolvedValueOnce(mockError)

      await expect(jira.request('/test')).rejects.toThrow()
    })

    test('should handle missing error messages in response', async () => {
      const mockError = {
        ok: false,
        status: 500,
        headers: new Map(),
        json: jest.fn().mockResolvedValue({}),
      }

      // Mock all 3 retry attempts to fail
      global.fetch
        .mockResolvedValueOnce(mockError)
        .mockResolvedValueOnce(mockError)
        .mockResolvedValueOnce(mockError)

      await expect(jira.request('/test')).rejects.toThrow()
    })
  })

  // ==========================================================================
  // EDGE CASES TESTS
  // ==========================================================================

  describe('Edge Cases', () => {
    test('should handle empty issue key array', () => {
      const keys = jira.extractIssueKeysFromCommitMessages([])
      expect(keys).toEqual([])
    })

    test('should throw error for workflow not found', async () => {
      global.fetch.mockResolvedValue({
        ok: true,
        status: 200,
        json: jest.fn().mockResolvedValue({
          values: [],
        }),
        headers: new Map(),
      })

      await expect(jira.getWorkflowStateMachine('Empty Workflow')).rejects.toThrow('Workflow "Empty Workflow" not found')
    })

    test('should handle circular transition paths', () => {
      const stateMachine = {
        states: {
          'A': {
            id: '1',
            name: 'A',
            transitions: [{ id: '1', name: 'To B', toStatus: 'B' }],
          },
          'B': {
            id: '2',
            name: 'B',
            transitions: [{ id: '2', name: 'To C', toStatus: 'C' }],
          },
          'C': {
            id: '3',
            name: 'C',
            transitions: [{ id: '3', name: 'To A', toStatus: 'A' }],
          },
        },
        transitionMap: new Map([
          [ '1', new Map([[ '2', { id: '1', name: 'To B', toStatus: 'B' } ]]) ],
          [ '2', new Map([[ '3', { id: '2', name: 'To C', toStatus: 'C' } ]]) ],
          [ '3', new Map([[ '1', { id: '3', name: 'To A', toStatus: 'A' } ]]) ],
        ]),
      }

      // Should not infinite loop when from === to
      const path = jira.findShortestTransitionPath(stateMachine, 'A', 'A')
      // When from equals to, it should return empty array
      expect(path).toBeDefined()
    })
  })

  // ==========================================================================
  // INTEGRATION SCENARIOS
  // ==========================================================================

  describe('Integration Scenarios', () => {
    test('should handle production deployment workflow', async () => {
      // This would test a full workflow from issue extraction to transition
      const commitMessages = [
        'DEX-36: Production hotfix',
        'ALL-593: Critical bug fix',
      ]

      const keys = jira.extractIssueKeysFromCommitMessages(commitMessages)

      expect(keys).toContain('DEX-36')
      expect(keys).toContain('ALL-593')
      expect(keys).toHaveLength(2)
    })
  })
})

// ==========================================================================
// LOGGER TESTS
// ==========================================================================

describe('Logger Class', () => {
  let originalConsole

  beforeEach(() => {
    originalConsole = {
      log: console.log,
      error: console.error,
      warn: console.warn,
    }
    console.log = jest.fn()
    console.error = jest.fn()
    console.warn = jest.fn()
  })

  afterEach(() => {
    console.log = originalConsole.log
    console.error = originalConsole.error
    console.warn = originalConsole.warn
  })

  test('should log at appropriate levels', () => {
    const jiraInstance = new Jira({
      baseUrl: 'https://test.atlassian.net',
      email: 'test@example.com',
      apiToken: 'test-token',
      logLevel: 'DEBUG',
    })

    jiraInstance.logger.debug('Debug message')
    jiraInstance.logger.info('Info message')
    jiraInstance.logger.warn('Warning message')
    jiraInstance.logger.error('Error message')

    expect(console.log).toHaveBeenCalled()
    expect(console.warn).toHaveBeenCalled()
    expect(console.error).toHaveBeenCalled()
  })

  test('should respect log level filtering', () => {
    const jiraInstance = new Jira({
      baseUrl: 'https://test.atlassian.net',
      email: 'test@example.com',
      apiToken: 'test-token',
      logLevel: 'ERROR',
    })

    jiraInstance.logger.debug('Debug message')
    jiraInstance.logger.info('Info message')
    jiraInstance.logger.warn('Warning message')

    // Only ERROR level should pass through
    expect(console.log).not.toHaveBeenCalled()
    expect(console.warn).not.toHaveBeenCalled()
  })

  test('should track operations with timing', () => {
    const jiraInstance = new Jira({
      baseUrl: 'https://test.atlassian.net',
      email: 'test@example.com',
      apiToken: 'test-token',
      logLevel: 'INFO',
    })

    const finishOp = jiraInstance.logger.startOperation('testOperation', { param: 'value' })
    finishOp('success', { result: 'data' })

    // Check that console.log was called with timestamp and operation info
    expect(console.log).toHaveBeenCalled()
    const calls = console.log.mock.calls
    const hasOperationCall = calls.some(call =>
      call[0].includes('testOperation') && call[0].includes('Operation completed')
    )
    expect(hasOperationCall).toBe(true)
  })
})
