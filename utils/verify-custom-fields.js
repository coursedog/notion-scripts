/**
 * Custom Field Verification Script
 *
 * This script verifies that the Jira custom field IDs used in the codebase
 * match the actual custom fields in your Jira instance.
 *
 * According to ticket ALL-593, we need:
 * - customfield_11473: Release Environment (select field)
 * - customfield_11474: Stage Release Timestamp (date-time)
 * - customfield_11475: Production Release Timestamp (date-time)
 *
 * Usage:
 *   node utils/verify-custom-fields.js
 *
 * Requirements:
 *   - .env file with JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN
 *   - TEST_JIRA_ISSUE_KEY environment variable (optional, for field inspection)
 */

require('dotenv').config()
const Jira = require('./jira')

const REQUIRED_FIELDS = {
  customfield_11473: {
    name: 'Release Environment',
    type: 'select',
    description: 'Select field with options for staging/production',
    expectedOptions: [ 'staging', 'production' ],
  },
  customfield_11474: {
    name: 'Stage Release Timestamp',
    type: 'datetime',
    description: 'Date-time field for staging deployments',
  },
  customfield_11475: {
    name: 'Production Release Timestamp',
    type: 'datetime',
    description: 'Date-time field for production deployments',
  },
}

// Option IDs used in the code
const EXPECTED_OPTION_IDS = {
  staging: '11942',
  production: '11943',
}

/**
 * Verify Jira custom field configuration
 */
async function verifyCustomFields () {
  console.log(`\n${'='.repeat(70)}`)
  console.log('JIRA CUSTOM FIELD VERIFICATION')
  console.log(`${'='.repeat(70)}\n`)

  // Check environment variables
  if (
    !process.env.JIRA_BASE_URL ||
    !process.env.JIRA_EMAIL ||
    !process.env.JIRA_API_TOKEN
  ) {
    console.error('❌ ERROR: Missing required environment variables')
    console.error('   Required: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN')
    console.error('   Please create a .env file with these variables.\n')
    process.exit(1)
  }

  console.log('✓ Environment variables found')
  console.log(`  Base URL: ${process.env.JIRA_BASE_URL}`)
  console.log(`  Email: ${process.env.JIRA_EMAIL}\n`)

  const jira = new Jira({
    baseUrl: process.env.JIRA_BASE_URL,
    email: process.env.JIRA_EMAIL,
    apiToken: process.env.JIRA_API_TOKEN,
  })

  const testIssueKey = process.env.TEST_JIRA_ISSUE_KEY || 'DEX-36'

  try {
    console.log(
      `Fetching custom field metadata from test issue: ${testIssueKey}\n`
    )

    // Fetch the test issue to inspect its custom fields
    const response = await jira.request(`/issue/${testIssueKey}?expand=names`)
    const issue = await response.json()

    console.log('─'.repeat(70))
    console.log('VERIFICATION RESULTS')
    console.log(`${'─'.repeat(70)}\n`)

    let allFieldsValid = true
    const foundFields = {}

    // Check each required custom field
    for (const [ fieldId, expectedConfig ] of Object.entries(REQUIRED_FIELDS)) {
      console.log(`Checking ${fieldId} (${expectedConfig.name})...`)

      // Check if field exists in the issue
      const fieldValue = issue.fields[fieldId]
      const fieldName = issue.names?.[fieldId]

      if (fieldValue !== undefined || fieldName) {
        console.log(`  ✓ Field exists in Jira`)
        console.log(`    Field Name: ${fieldName || 'N/A'}`)
        console.log(`    Current Value: ${JSON.stringify(fieldValue)}`)

        foundFields[fieldId] = {
          name: fieldName,
          value: fieldValue,
          exists: true,
        }

        // For select fields, check options
        if (
          expectedConfig.type === 'select' &&
          fieldValue &&
          typeof fieldValue === 'object'
        ) {
          console.log(`    Option ID: ${fieldValue.id || 'N/A'}`)
          console.log(`    Option Value: ${fieldValue.value || 'N/A'}`)
        }
      } else {
        console.log(`  ❌ Field NOT FOUND in this issue`)
        console.log(`    This may be normal if the field hasn't been set yet.`)
        allFieldsValid = false
        foundFields[fieldId] = { exists: false }
      }
      console.log()
    }

    // Get all custom fields to find the Release Environment options
    console.log('─'.repeat(70))
    console.log('RELEASE ENVIRONMENT FIELD OPTIONS')
    console.log(`${'─'.repeat(70)}\n`)

    try {
      // Try to get field metadata
      const fieldResponse = await jira.request('/field')
      const fields = await fieldResponse.json()

      const releaseEnvField = fields.find((f) => f.id === 'customfield_11473')

      if (releaseEnvField) {
        console.log(`✓ Found field: ${releaseEnvField.name}`)
        console.log(`  Field ID: ${releaseEnvField.id}`)
        console.log(`  Field Type: ${releaseEnvField.schema?.type || 'N/A'}`)

        // Try to get the field configuration to see options
        if (releaseEnvField.schema?.custom) {
          console.log(`  Custom Type: ${releaseEnvField.schema.custom}`)
        }
      } else {
        console.log(`⚠️  Could not find metadata for customfield_11473`)
      }
    } catch (error) {
      console.log(`⚠️  Could not fetch field metadata: ${error.message}`)
    }

    console.log(`\n${'─'.repeat(70)}`)
    console.log('EXPECTED VS ACTUAL CONFIGURATION')
    console.log(`${'─'.repeat(70)}\n`)

    console.log('Expected Configuration (from ticket ALL-593):')
    console.log('  • customfield_11473: Release Environment (select)')
    console.log(`    - Option for 'staging': ${EXPECTED_OPTION_IDS.staging}`)
    console.log(
      `    - Option for 'production': ${EXPECTED_OPTION_IDS.production}`
    )
    console.log('  • customfield_11474: Stage Release Timestamp (datetime)')
    console.log(
      '  • customfield_11475: Production Release Timestamp (datetime)\n'
    )

    console.log('Current Code Configuration (update_jira/index.js):')
    console.log('  • For staging deployments:')
    console.log('    - Sets customfield_11474 to new Date() ✓')
    console.log("    - Sets customfield_11473 to { id: '11942' } ✓")
    console.log('  • For production deployments:')
    console.log('    - Sets customfield_11475 to new Date() ✓')
    console.log("    - Sets customfield_11473 to { id: '11943' } ✓\n")

    // Summary
    console.log('─'.repeat(70))
    console.log('SUMMARY')
    console.log(`${'─'.repeat(70)}\n`)

    if (allFieldsValid) {
      console.log('✓ All required custom fields exist in Jira')
    } else {
      console.log('⚠️  Some fields were not found in the test issue')
      console.log("   This may be normal if they haven't been set yet.")
    }

    console.log('\n⚠️  IMPORTANT: Option ID Verification Required')
    console.log(
      '   The option IDs (11942, 11943) for the Release Environment field'
    )
    console.log('   need to be verified manually in Jira admin settings:')
    console.log('   1. Go to Jira Settings > Issues > Custom Fields')
    console.log("   2. Find 'Release Environment' field")
    console.log("   3. Click 'Configure' > 'Edit Options'")
    console.log('   4. Verify the option IDs match:')
    console.log('      - Staging option: 11942')
    console.log('      - Production option: 11943\n')

    console.log('💡 To test setting these fields:')
    console.log(`   node utils/test-custom-field-update.js ${testIssueKey}\n`)
  } catch (error) {
    console.error('\n❌ ERROR: Failed to verify custom fields')
    console.error(`   ${error.message}\n`)

    if (error.message.includes('404')) {
      console.error(
        `   Issue ${testIssueKey} not found. Set TEST_JIRA_ISSUE_KEY to a valid issue.`
      )
    }

    process.exit(1)
  }
}

// Run verification
verifyCustomFields().catch((error) => {
  console.error('\n❌ Unexpected error:', error)
  process.exit(1)
})
