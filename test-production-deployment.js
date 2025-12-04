/**
 * Test script for ALL-675: Production deployment fix verification
 *
 * This script tests that production deployments correctly:
 * 1. Transition issues to "Done" status
 * 2. Set Production Release Timestamp (customfield_11475)
 * 3. Set Release Environment to "production" (customfield_11473)
 */

require('dotenv').config()
const Jira = require('./utils/jira')

// Configuration
const TEST_ISSUE_KEY = 'ALL-675'
const PRODUCTION_STATUS = 'Done'

// Custom field IDs
const CUSTOM_FIELDS = {
  RELEASE_ENVIRONMENT: 'customfield_11473',
  STAGING_TIMESTAMP: 'customfield_11474',
  PRODUCTION_TIMESTAMP: 'customfield_11475',
}

const RELEASE_ENV_IDS = {
  STAGING: '11942',
  PRODUCTION: '11943',
}

/**
 * Main test function
 */
async function testProductionDeployment () {
  console.log('='.repeat(70))
  console.log('Testing Production Deployment Fix (ALL-675)')
  console.log('='.repeat(70))
  console.log()

  try {
    // Initialize Jira client
    console.log('📡 Initializing Jira client...')
    const jira = new Jira({
      baseUrl: process.env.JIRA_BASE_URL,
      email: process.env.JIRA_EMAIL,
      apiToken: process.env.JIRA_API_TOKEN,
      logLevel: 'INFO',
    })
    console.log('✅ Jira client initialized\n')

    // Step 1: Get current issue state
    console.log(`📋 Fetching current state of ${TEST_ISSUE_KEY}...`)
    const issueResponse = await jira.request(`/issue/${TEST_ISSUE_KEY}?fields=status,summary,${CUSTOM_FIELDS.RELEASE_ENVIRONMENT},${CUSTOM_FIELDS.PRODUCTION_TIMESTAMP}`)
    const issueData = await issueResponse.json()

    console.log(`   Issue: ${issueData.key} - ${issueData.fields.summary}`)
    console.log(`   Current Status: ${issueData.fields.status.name}`)
    console.log(`   Release Environment: ${issueData.fields[CUSTOM_FIELDS.RELEASE_ENVIRONMENT]?.value || 'Not set'}`)
    console.log(`   Production Timestamp: ${issueData.fields[CUSTOM_FIELDS.PRODUCTION_TIMESTAMP] || 'Not set'}`)
    console.log()

    // Step 2: Simulate production deployment - Transition to "Done"
    console.log('🚀 Simulating production deployment...')
    console.log(`   Transitioning ${TEST_ISSUE_KEY} to "${PRODUCTION_STATUS}"...`)

    // Note: Don't pass resolution field - it's not on the transition screen
    // The Jira utility will auto-populate required fields if needed
    const transitionFields = {}

    const customFields = {
      [CUSTOM_FIELDS.PRODUCTION_TIMESTAMP]: new Date().toISOString(),
      [CUSTOM_FIELDS.RELEASE_ENVIRONMENT]: { id: RELEASE_ENV_IDS.PRODUCTION },
    }

    // Transition issue
    await jira.transitionIssue(
      TEST_ISSUE_KEY,
      PRODUCTION_STATUS,
      [ 'Blocked', 'Rejected' ],
      transitionFields
    )
    console.log(`   ✅ Transitioned to "${PRODUCTION_STATUS}"`)

    // Update custom fields
    console.log('   Updating custom fields...')
    await jira.updateCustomFields(TEST_ISSUE_KEY, customFields)
    console.log('   ✅ Custom fields updated')
    console.log()

    // Step 3: Verify the changes
    console.log('🔍 Verifying changes...')
    const verifyResponse = await jira.request(`/issue/${TEST_ISSUE_KEY}?fields=status,${CUSTOM_FIELDS.RELEASE_ENVIRONMENT},${CUSTOM_FIELDS.PRODUCTION_TIMESTAMP}`)
    const verifiedData = await verifyResponse.json()

    const finalStatus = verifiedData.fields.status.name
    const releaseEnv = verifiedData.fields[CUSTOM_FIELDS.RELEASE_ENVIRONMENT]
    const productionTimestamp = verifiedData.fields[CUSTOM_FIELDS.PRODUCTION_TIMESTAMP]

    console.log()
    console.log('='.repeat(70))
    console.log('VERIFICATION RESULTS')
    console.log('='.repeat(70))

    let allTestsPassed = true

    // Test 1: Status transition
    if (finalStatus === PRODUCTION_STATUS) {
      console.log(`✅ Status: ${finalStatus} (correct)`)
    } else {
      console.log(`❌ Status: ${finalStatus} (expected: ${PRODUCTION_STATUS})`)
      allTestsPassed = false
    }

    // Test 2: Release Environment
    if (releaseEnv && releaseEnv.id === RELEASE_ENV_IDS.PRODUCTION) {
      console.log(`✅ Release Environment: ${releaseEnv.value} (ID: ${releaseEnv.id}) (correct)`)
    } else {
      console.log(`❌ Release Environment: ${releaseEnv?.value || 'Not set'} (expected: production with ID ${RELEASE_ENV_IDS.PRODUCTION})`)
      allTestsPassed = false
    }

    // Test 3: Production Timestamp
    if (productionTimestamp) {
      const timestamp = new Date(productionTimestamp)
      const now = new Date()
      const diffMinutes = (now - timestamp) / (1000 * 60)

      if (diffMinutes < 5) {
        console.log(`✅ Production Timestamp: ${productionTimestamp} (set ${Math.round(diffMinutes)} minute(s) ago)`)
      } else {
        console.log(`⚠️  Production Timestamp: ${productionTimestamp} (set ${Math.round(diffMinutes)} minute(s) ago - may be from previous test)`)
      }
    } else {
      console.log('❌ Production Timestamp: Not set')
      allTestsPassed = false
    }

    console.log('='.repeat(70))
    console.log()

    if (allTestsPassed) {
      console.log('🎉 ALL TESTS PASSED! Production deployment logic is working correctly.')
      console.log()
      console.log('✅ The fix for ALL-675 is verified and ready for production.')
      console.log('✅ Issues will now correctly transition to "Done" with timestamps.')
      return 0
    } else {
      console.log('❌ SOME TESTS FAILED! Please review the results above.')
      return 1
    }

  } catch (error) {
    console.error()
    console.error('='.repeat(70))
    console.error('❌ TEST FAILED WITH ERROR')
    console.error('='.repeat(70))
    console.error(`Error: ${error.message}`)
    if (error.context) {
      console.error('Context:', JSON.stringify(error.context, null, 2))
    }
    console.error()
    console.error('Stack trace:')
    console.error(error.stack)
    return 1
  }
}

// Run the test
testProductionDeployment()
  .then((exitCode) => {
    process.exit(exitCode)
  })
  .catch((error) => {
    console.error('Unhandled error:', error)
    process.exit(1)
  })
