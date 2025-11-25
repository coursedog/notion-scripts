/**
 * @fileoverview Comprehensive Unit Tests for update_jira/index.js
 * @module update_jira/index.test
 *
 * Run with: npm test
 * Run specific file: npx jest update_jira/index.test.js
 * Run with coverage: npx jest --coverage
 */

const {
  detectEnvironment,
  extractJiraIssueKeys,
  extractPrNumber,
  deduplicateIssueKeys,
  constructPrUrl,
  parseRepository,
  isValidIssueKey,
  GitHubActionError,
  EventProcessingError,
  ConfigurationError,
  GitHubApiError,
} = require('./index')

// ============================================================================
// UTILITY FUNCTIONS TESTS
// ============================================================================

describe('detectEnvironment', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test('should detect github environment', () => {
    process.env.GITHUB_ACTIONS = 'true'
    expect(detectEnvironment()).toBe('github')
  })

  test('should detect ci environment', () => {
    delete process.env.GITHUB_ACTIONS
    process.env.CI = 'true'
    expect(detectEnvironment()).toBe('ci')
  })

  test('should detect local environment', () => {
    delete process.env.GITHUB_ACTIONS
    delete process.env.CI
    expect(detectEnvironment()).toBe('local')
  })

  test('should prioritize GITHUB_ACTIONS over CI', () => {
    process.env.GITHUB_ACTIONS = 'true'
    process.env.CI = 'true'
    expect(detectEnvironment()).toBe('github')
  })
})

// ============================================================================
// ISSUE KEY EXTRACTION TESTS
// ============================================================================

describe('extractJiraIssueKeys', () => {
  test('should extract issue keys from PR title', () => {
    const pullRequest = {
      number: 123,
      title: 'DEX-36: Fix bug in authentication',
      body: null,
    }
    const keys = extractJiraIssueKeys(pullRequest)
    expect(keys).toEqual([ 'DEX-36' ])
  })

  test('should extract issue keys from PR body', () => {
    const pullRequest = {
      number: 123,
      title: 'Fix authentication bug',
      body: 'This fixes ALL-593 and DEX-36',
    }
    const keys = extractJiraIssueKeys(pullRequest)
    expect(keys).toContain('ALL-593')
    expect(keys).toContain('DEX-36')
    expect(keys).toHaveLength(2)
  })

  test('should extract issue keys from both title and body', () => {
    const pullRequest = {
      number: 123,
      title: 'DEX-36: Fix bug',
      body: 'Also fixes ALL-593',
    }
    const keys = extractJiraIssueKeys(pullRequest)
    expect(keys).toContain('DEX-36')
    expect(keys).toContain('ALL-593')
    expect(keys).toHaveLength(2)
  })

  test('should deduplicate issue keys from title and body', () => {
    const pullRequest = {
      number: 123,
      title: 'DEX-36: Fix bug',
      body: 'This PR fixes DEX-36',
    }
    const keys = extractJiraIssueKeys(pullRequest)
    expect(keys).toEqual([ 'DEX-36' ])
  })

  test('should extract multiple issue keys', () => {
    const pullRequest = {
      number: 123,
      title: 'DEX-36 ALL-593 INT-874: Multiple fixes',
      body: 'Also fixes CM-2061',
    }
    const keys = extractJiraIssueKeys(pullRequest)
    expect(keys).toHaveLength(4)
    expect(keys).toContain('DEX-36')
    expect(keys).toContain('ALL-593')
    expect(keys).toContain('INT-874')
    expect(keys).toContain('CM-2061')
  })

  test('should return empty array when no keys found', () => {
    const pullRequest = {
      number: 123,
      title: 'Fix authentication bug',
      body: 'No ticket reference',
    }
    const keys = extractJiraIssueKeys(pullRequest)
    expect(keys).toEqual([])
  })

  test('should handle null/undefined body gracefully', () => {
    const pullRequest = {
      number: 123,
      title: 'DEX-36: Fix bug',
      body: null,
    }
    const keys = extractJiraIssueKeys(pullRequest)
    expect(keys).toEqual([ 'DEX-36' ])
  })

  test('should filter out invalid issue key formats', () => {
    const pullRequest = {
      number: 123,
      title: 'DEX-36 INVALID-KEY 123-456',
      body: 'AB-12',
    }
    const keys = extractJiraIssueKeys(pullRequest)
    expect(keys).toContain('DEX-36')
    expect(keys).toContain('AB-12')
    // 123-456 should be filtered out (starts with number)
    expect(keys).not.toContain('123-456')
  })

  test('should handle lowercase issue keys', () => {
    const pullRequest = {
      number: 123,
      title: 'dex-36: Fix bug',
      body: null,
    }
    const keys = extractJiraIssueKeys(pullRequest)
    // Should not extract lowercase keys
    expect(keys).toEqual([])
  })
})

// ============================================================================
// ISSUE KEY VALIDATION TESTS
// ============================================================================

describe('isValidIssueKey', () => {
  test('should validate correct issue keys', () => {
    expect(isValidIssueKey('DEX-36')).toBe(true)
    expect(isValidIssueKey('ALL-593')).toBe(true)
    expect(isValidIssueKey('INT-874')).toBe(true)
    expect(isValidIssueKey('CM-2061')).toBe(true)
    expect(isValidIssueKey('A-1')).toBe(true)
    expect(isValidIssueKey('ABC123-999')).toBe(true)
  })

  test('should reject invalid issue keys', () => {
    expect(isValidIssueKey('dex-36')).toBe(false) // lowercase
    expect(isValidIssueKey('DEX36')).toBe(false) // no dash
    expect(isValidIssueKey('123-456')).toBe(false) // starts with number
    expect(isValidIssueKey('DEX-')).toBe(false) // no number
    expect(isValidIssueKey('-36')).toBe(false) // no project key
    expect(isValidIssueKey('')).toBe(false) // empty
    expect(isValidIssueKey('D-1-2')).toBe(false) // multiple dashes
  })

  test('should handle edge cases', () => {
    expect(isValidIssueKey(null)).toBe(false)
    expect(isValidIssueKey(undefined)).toBe(false)
    expect(isValidIssueKey(123)).toBe(false)
    expect(isValidIssueKey({})).toBe(false)
  })
})

// ============================================================================
// ISSUE KEY DEDUPLICATION TESTS
// ============================================================================

describe('deduplicateIssueKeys', () => {
  test('should deduplicate issue keys from multiple arrays', () => {
    const keys1 = [ 'DEX-36', 'ALL-593' ]
    const keys2 = [ 'DEX-36', 'INT-874' ]
    const keys3 = [ 'ALL-593', 'CM-2061' ]

    const result = deduplicateIssueKeys(keys1, keys2, keys3)

    expect(result).toHaveLength(4)
    expect(result).toContain('DEX-36')
    expect(result).toContain('ALL-593')
    expect(result).toContain('INT-874')
    expect(result).toContain('CM-2061')
  })

  test('should filter out invalid keys during deduplication', () => {
    const keys1 = [ 'DEX-36', 'invalid-key' ]
    const keys2 = [ '123-456', 'ALL-593' ]

    const result = deduplicateIssueKeys(keys1, keys2)

    expect(result).toHaveLength(2)
    expect(result).toContain('DEX-36')
    expect(result).toContain('ALL-593')
    expect(result).not.toContain('invalid-key')
    expect(result).not.toContain('123-456')
  })

  test('should handle empty arrays', () => {
    const result = deduplicateIssueKeys([], [], [])
    expect(result).toEqual([])
  })

  test('should handle single array', () => {
    const keys = [ 'DEX-36', 'ALL-593', 'DEX-36' ]
    const result = deduplicateIssueKeys(keys)

    expect(result).toHaveLength(2)
    expect(result).toContain('DEX-36')
    expect(result).toContain('ALL-593')
  })

  test('should handle non-array arguments gracefully', () => {
    const result = deduplicateIssueKeys([ 'DEX-36' ], null, undefined, 'not-array')
    expect(result).toEqual([ 'DEX-36' ])
  })
})

// ============================================================================
// PR NUMBER EXTRACTION TESTS
// ============================================================================

describe('extractPrNumber', () => {
  test('should extract PR number from commit message', () => {
    const message = 'Merge pull request #123 from branch'
    expect(extractPrNumber(message)).toBe('123')
  })

  test('should extract PR number with other text', () => {
    const message = 'Some changes (#456)'
    expect(extractPrNumber(message)).toBe('456')
  })

  test('should return first PR number if multiple exist', () => {
    const message = 'Fixes #123 and #456'
    expect(extractPrNumber(message)).toBe('123')
  })

  test('should return null when no PR number found', () => {
    const message = 'No PR number here'
    expect(extractPrNumber(message)).toBeNull()
  })

  test('should handle null/undefined commit message', () => {
    expect(extractPrNumber(null)).toBeNull()
    expect(extractPrNumber(undefined)).toBeNull()
  })

  test('should handle empty commit message', () => {
    expect(extractPrNumber('')).toBeNull()
  })
})

// ============================================================================
// PR URL CONSTRUCTION TESTS
// ============================================================================

describe('constructPrUrl', () => {
  test('should construct correct PR URL', () => {
    const url = constructPrUrl('coursedog', 'notion-scripts', 123)
    expect(url).toBe('coursedog/notion-scripts/pull/123')
  })

  test('should handle string PR number', () => {
    const url = constructPrUrl('owner', 'repo', '456')
    expect(url).toBe('owner/repo/pull/456')
  })

  test('should handle special characters in owner/repo', () => {
    const url = constructPrUrl('owner-name', 'repo_name', 789)
    expect(url).toBe('owner-name/repo_name/pull/789')
  })
})

// ============================================================================
// REPOSITORY PARSING TESTS
// ============================================================================

describe('parseRepository', () => {
  test('should parse valid repository string', () => {
    const result = parseRepository('coursedog/notion-scripts')
    expect(result).toEqual({
      owner: 'coursedog',
      repo: 'notion-scripts',
    })
  })

  test('should parse repository with special characters', () => {
    const result = parseRepository('owner-name/repo_name')
    expect(result).toEqual({
      owner: 'owner-name',
      repo: 'repo_name',
    })
  })

  test('should throw ConfigurationError for invalid format', () => {
    expect(() => parseRepository('invalid')).toThrow(ConfigurationError)
    expect(() => parseRepository('invalid')).toThrow('Invalid repository format')
  })

  test('should throw ConfigurationError for null/undefined', () => {
    expect(() => parseRepository(null)).toThrow(ConfigurationError)
    expect(() => parseRepository(undefined)).toThrow(ConfigurationError)
  })

  test('should throw ConfigurationError for empty string', () => {
    expect(() => parseRepository('')).toThrow(ConfigurationError)
  })

  test('should handle repository with multiple slashes (take first two)', () => {
    const result = parseRepository('owner/repo/extra')
    expect(result.owner).toBe('owner')
    expect(result.repo).toBe('repo/extra') // Takes everything after first slash
  })
})

// ============================================================================
// ERROR CLASSES TESTS
// ============================================================================

describe('Error Classes', () => {
  describe('GitHubActionError', () => {
    test('should create error with message and context', () => {
      const error = new GitHubActionError('Test error', { key: 'value' })

      expect(error).toBeInstanceOf(Error)
      expect(error).toBeInstanceOf(GitHubActionError)
      expect(error.message).toBe('Test error')
      expect(error.context).toEqual({ key: 'value' })
      expect(error.name).toBe('GitHubActionError')
      expect(error.timestamp).toBeDefined()
      expect(error.stack).toBeDefined()
    })

    test('should work without context', () => {
      const error = new GitHubActionError('Test error')
      expect(error.context).toEqual({})
    })
  })

  describe('EventProcessingError', () => {
    test('should create error with event type', () => {
      const eventData = { action: 'opened', pull_request: {} }
      const error = new EventProcessingError('Test error', 'pull_request', eventData)

      expect(error).toBeInstanceOf(GitHubActionError)
      expect(error).toBeInstanceOf(EventProcessingError)
      expect(error.message).toBe('Test error')
      expect(error.eventType).toBe('pull_request')
      expect(error.context.eventType).toBe('pull_request')
      expect(error.context.eventData).toEqual(eventData)
    })
  })

  describe('ConfigurationError', () => {
    test('should create error with missing config list', () => {
      const missingConfig = [ 'JIRA_BASE_URL', 'JIRA_EMAIL' ]
      const error = new ConfigurationError('Missing config', missingConfig)

      expect(error).toBeInstanceOf(GitHubActionError)
      expect(error).toBeInstanceOf(ConfigurationError)
      expect(error.message).toBe('Missing config')
      expect(error.missingConfig).toEqual(missingConfig)
      expect(error.context.missingConfig).toEqual(missingConfig)
    })
  })

  describe('GitHubApiError', () => {
    test('should create error with status code and operation', () => {
      const error = new GitHubApiError('API failed', 429, 'getCommit')

      expect(error).toBeInstanceOf(GitHubActionError)
      expect(error).toBeInstanceOf(GitHubApiError)
      expect(error.message).toBe('API failed')
      expect(error.statusCode).toBe(429)
      expect(error.operation).toBe('getCommit')
      expect(error.context.statusCode).toBe(429)
      expect(error.context.operation).toBe('getCommit')
    })
  })
})

// ============================================================================
// INTEGRATION SCENARIOS TESTS
// ============================================================================

describe('Integration Scenarios', () => {
  describe('PR to Production Flow', () => {
    test('should extract and validate issue keys for production PR', () => {
      const pullRequest = {
        number: 123,
        title: 'DEX-36: Production hotfix',
        body: 'Fixes critical bug. Related: ALL-593',
        base: { ref: 'main' },
        merged: true,
      }

      const keys = extractJiraIssueKeys(pullRequest)
      expect(keys).toHaveLength(2)
      expect(keys).toContain('DEX-36')
      expect(keys).toContain('ALL-593')

      // Verify all keys are valid
      keys.forEach(key => {
        expect(isValidIssueKey(key)).toBe(true)
      })
    })
  })

  describe('Staging Deployment Flow', () => {
    test('should construct correct PR URL for staging deployment', () => {
      const repository = 'coursedog/notion-scripts'
      const commitMessage = 'Merge pull request #456 into staging'

      const { owner, repo } = parseRepository(repository)
      const prNumber = extractPrNumber(commitMessage)
      const prUrl = constructPrUrl(owner, repo, prNumber)

      expect(prUrl).toBe('coursedog/notion-scripts/pull/456')
    })
  })

  describe('Multiple Issue Keys Flow', () => {
    test('should deduplicate keys from PR and commit history', () => {
      // Keys from PR
      const prKeys = [ 'DEX-36', 'ALL-593' ]

      // Keys from commit history (may include duplicates)
      const commitKeys1 = [ 'DEX-36', 'INT-874' ]
      const commitKeys2 = [ 'ALL-593', 'CM-2061' ]

      const allKeys = deduplicateIssueKeys(prKeys, commitKeys1, commitKeys2)

      expect(allKeys).toHaveLength(4)
      expect(allKeys).toContain('DEX-36')
      expect(allKeys).toContain('ALL-593')
      expect(allKeys).toContain('INT-874')
      expect(allKeys).toContain('CM-2061')
    })
  })
})

// ============================================================================
// EDGE CASES TESTS
// ============================================================================

describe('Edge Cases', () => {
  describe('Malformed Input Handling', () => {
    test('extractJiraIssueKeys should handle missing PR number', () => {
      const pullRequest = {
        title: 'DEX-36: Fix bug',
        body: null,
      }
      const keys = extractJiraIssueKeys(pullRequest)
      expect(keys).toEqual([ 'DEX-36' ])
    })

    test('should handle very long PR titles', () => {
      const longTitle = 'DEX-36: ' + 'a'.repeat(10000)
      const pullRequest = {
        number: 123,
        title: longTitle,
        body: null,
      }
      const keys = extractJiraIssueKeys(pullRequest)
      expect(keys).toEqual([ 'DEX-36' ])
    })

    test('should handle unicode characters in PR title', () => {
      const pullRequest = {
        number: 123,
        title: 'DEX-36: Fix bug 🐛 with emojis ✨',
        body: null,
      }
      const keys = extractJiraIssueKeys(pullRequest)
      expect(keys).toEqual([ 'DEX-36' ])
    })
  })

  describe('Boundary Conditions', () => {
    test('should handle single character project key', () => {
      const pullRequest = {
        number: 123,
        title: 'A-1: Short key',
        body: null,
      }
      const keys = extractJiraIssueKeys(pullRequest)
      expect(keys).toEqual([ 'A-1' ])
      expect(isValidIssueKey('A-1')).toBe(true)
    })

    test('should handle very large issue numbers', () => {
      const issueKey = 'DEX-999999'
      expect(isValidIssueKey(issueKey)).toBe(true)
    })

    test('should handle empty issue keys array in deduplication', () => {
      const result = deduplicateIssueKeys([])
      expect(result).toEqual([])
    })
  })

  describe('Special Characters Handling', () => {
    test('should handle PR titles with special regex characters', () => {
      const pullRequest = {
        number: 123,
        title: 'DEX-36: Fix bug [with] (brackets) and $pecial characters',
        body: null,
      }
      const keys = extractJiraIssueKeys(pullRequest)
      expect(keys).toEqual([ 'DEX-36' ])
    })

    test('should handle repository names with hyphens and underscores', () => {
      const result = parseRepository('my-org_name/my-repo_name')
      expect(result).toEqual({
        owner: 'my-org_name',
        repo: 'my-repo_name',
      })
    })
  })
})

// ============================================================================
// PERFORMANCE TESTS
// ============================================================================

describe('Performance', () => {
  test('should handle large number of issue keys efficiently', () => {
    const largeArray = Array.from({ length: 1000 }, (_, i) => `PROJ-${i}`)
    const start = Date.now()
    const result = deduplicateIssueKeys(largeArray, largeArray, largeArray)
    const duration = Date.now() - start

    expect(result).toHaveLength(1000)
    expect(duration).toBeLessThan(1000) // Should complete in less than 1 second
  })

  test('should handle very long PR body efficiently', () => {
    const largeBody = 'DEX-36 ' + 'a'.repeat(100000)
    const pullRequest = {
      number: 123,
      title: 'Fix',
      body: largeBody,
    }

    const start = Date.now()
    const keys = extractJiraIssueKeys(pullRequest)
    const duration = Date.now() - start

    expect(keys).toEqual([ 'DEX-36' ])
    expect(duration).toBeLessThan(1000) // Should complete in less than 1 second
  })
})

// ============================================================================
// MOCK TESTS FOR ENVIRONMENT-DEPENDENT CODE
// ============================================================================

describe('Environment-Dependent Behavior', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test('should detect correct environment in different scenarios', () => {
    // GitHub Actions
    process.env.GITHUB_ACTIONS = 'true'
    process.env.CI = 'false'
    expect(detectEnvironment()).toBe('github')

    // CI environment (not GitHub Actions)
    delete process.env.GITHUB_ACTIONS
    process.env.CI = 'true'
    expect(detectEnvironment()).toBe('ci')

    // Local environment
    delete process.env.CI
    expect(detectEnvironment()).toBe('local')
  })
})
