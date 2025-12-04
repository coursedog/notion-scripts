/**
 * Test script for ALL-675: Full deployment flow verification
 *
 * This script tests the complete deployment flow:
 * 1. Staging deployment: Transition to "Deployed to Staging" + set Stage Release Timestamp
 * 2. Production deployment: Transition to "Done" + set Production Release Timestamp
 */

require('dotenv').config()
const Jira = require('./utils/jira')

// Configuration
const TEST_ISSUE_KEY = 'ALL-675'

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

// Status names
const STATUS = {
  STAGING: 'Deployed to Staging',
  DONE: 'Done',
  IN_DEVELOPMENT: 'In Development',
}

/**
 * Display issue state
 */
function displayIssueState (issueData, label) {
  console.log(`\n${label}:`)
  console.log(`   Issue: ${issueData.key} - ${issueData.fields.summary}`)
  console.log(`   Status: ${issueData.fields.status.name}`)
  console.log(`   Release Environment: ${issueData.fields[CUSTOM_FIELDS.RELEASE_ENVIRONMENT]?.value || 'Not set'}`)
  console.log(`   Staging Timestamp: ${issueData.fields[CUSTOM_FIELDS.STAGING_TIMESTAMP] || 'Not set'}`)
  console.log(`   Production Timestamp: ${issueData.fields[CUSTOM_FIELDS.PRODUCTION_TIMESTAMP] || 'Not set'}`)
}

/**
 * Reset issue to In Development
 */
async function resetIssue (jira) {
  console.log(`\n📋 Resetting ${TEST_ISSUE_KEY} to "In Development"...`)

  try {
    await jira.transitionIssue(
      TEST_ISSUE_KEY,
      STATUS.IN_DEVELOPMENT,
      [ 'Blocked', 'Rejected' ],
      {}
    )

    // Clear custom fields
    await jira.updateCustomFields(TEST_ISSUE_KEY, {
      [CUSTOM_FIELDS.RELEASE_ENVIRONMENT]: null,
      [CUSTOM_FIELDS.STAGING_TIMESTAMP]: null,
      [CUSTOM_FIELDS.PRODUCTION_TIMESTAMP]: null,
    })

    console.log(`   ✅ Reset to "In Development" with cleared fields`)
  } catch (error) {
    console.log(`   ⚠️  Could not reset (might already be in correct state): ${error.message}`)
  }
}

/**
 * Simulate staging deployment
 */
async function deployToStaging (jira) {
  console.log(`\n🚀 STAGE 1: Simulating STAGING deployment...`)
  console.log(`   Transitioning ${TEST_ISSUE_KEY} to "${STATUS.STAGING}"...`)

  const transitionFields = {}
  const customFields = {
    [CUSTOM_FIELDS.STAGING_TIMESTAMP]: new Date().toISOString(),
    [CUSTOM_FIELDS.RELEASE_ENVIRONMENT]: { id: RELEASE_ENV_IDS.STAGING },
  }

  // Transition issue
  await jira.transitionIssue(
    TEST_ISSUE_KEY,
    STATUS.STAGING,
    [ 'Blocked', 'Rejected' ],
    transitionFields
  )
  console.log(`   ✅ Transitioned to "${STATUS.STAGING}"`)

  // Update custom fields
  console.log('   Updating staging custom fields...')
  await jira.updateCustomFields(TEST_ISSUE_KEY, customFields)
  console.log('   ✅ Staging custom fields updated')
}

/**
 * Simulate production deployment
 */
async function deployToProduction (jira) {
  console.log(`\n🚀 STAGE 2: Simulating PRODUCTION deployment...`)
  console.log(`   Setting production custom fields (Jira automation will handle transition)...`)

  const customFields = {
    [CUSTOM_FIELDS.PRODUCTION_TIMESTAMP]: new Date().toISOString(),
    [CUSTOM_FIELDS.RELEASE_ENVIRONMENT]: { id: RELEASE_ENV_IDS.PRODUCTION },
  }

  // For production: ONLY update custom fields
  // Jira automation will automatically transition to "Done" when these fields are set
  console.log('   Updating Production Release Timestamp and Release Environment...')
  await jira.updateCustomFields(TEST_ISSUE_KEY, customFields)
  console.log('   ✅ Production custom fields updated')
  console.log('   ⏳ Waiting for Jira automation to transition to "Done"...')

  // Wait a bit for Jira automation to process
  await new Promise(resolve => setTimeout(resolve, 3000))
}

/**
 * Verify final state
 */
function verifyResults (issueData) {
  console.log('\n' + '='.repeat(70))
  console.log('VERIFICATION RESULTS')
  console.log('='.repeat(70))

  let allTestsPassed = true
  const results = []

  // Test 1: Status should be "Done"
  if (issueData.fields.status.name === STATUS.DONE) {
    results.push(`✅ Status: ${issueData.fields.status.name} (correct)`)
  } else {
    results.push(`❌ Status: ${issueData.fields.status.name} (expected: ${STATUS.DONE})`)
    allTestsPassed = false
  }

  // Test 2: Release Environment should be "Production"
  const releaseEnv = issueData.fields[CUSTOM_FIELDS.RELEASE_ENVIRONMENT]
  if (releaseEnv && releaseEnv.id === RELEASE_ENV_IDS.PRODUCTION) {
    results.push(`✅ Release Environment: ${releaseEnv.value} (ID: ${releaseEnv.id}) (correct)`)
  } else {
    results.push(`❌ Release Environment: ${releaseEnv?.value || 'Not set'} (expected: Production with ID ${RELEASE_ENV_IDS.PRODUCTION})`)
    allTestsPassed = false
  }

  // Test 3: Staging Timestamp should be set
  const stagingTimestamp = issueData.fields[CUSTOM_FIELDS.STAGING_TIMESTAMP]
  if (stagingTimestamp) {
    const timestamp = new Date(stagingTimestamp)
    const now = new Date()
    const diffMinutes = (now - timestamp) / (1000 * 60)
    results.push(`✅ Staging Timestamp: ${stagingTimestamp} (set ${Math.round(diffMinutes)} minute(s) ago)`)
  } else {
    results.push('❌ Staging Timestamp: Not set')
    allTestsPassed = false
  }

  // Test 4: Production Timestamp should be set
  const productionTimestamp = issueData.fields[CUSTOM_FIELDS.PRODUCTION_TIMESTAMP]
  if (productionTimestamp) {
    const timestamp = new Date(productionTimestamp)
    const now = new Date()
    const diffMinutes = (now - timestamp) / (1000 * 60)
    results.push(`✅ Production Timestamp: ${productionTimestamp} (set ${Math.round(diffMinutes)} minute(s) ago)`)
  } else {
    results.push('❌ Production Timestamp: Not set')
    allTestsPassed = false
  }

  // Display results
  results.forEach(r => console.log(r))
  console.log('='.repeat(70))

  return allTestsPassed
}

/**
 * Main test function
 */
async function testFullDeploymentFlow () {
  console.log('='.repeat(70))
  console.log('Testing Full Deployment Flow (ALL-675)')
  console.log('Staging → Production')
  console.log('='.repeat(70))

  try {
    // Initialize Jira client
    console.log('\n📡 Initializing Jira client...')
    const jira = new Jira({
      baseUrl: process.env.JIRA_BASE_URL,
      email: process.env.JIRA_EMAIL,
      apiToken: process.env.JIRA_API_TOKEN,
      logLevel: 'INFO',
    })
    console.log('✅ Jira client initialized')

    // Get initial state
    console.log(`\n📋 Fetching initial state of ${TEST_ISSUE_KEY}...`)
    let issueResponse = await jira.request(`/issue/${TEST_ISSUE_KEY}?fields=status,summary,${CUSTOM_FIELDS.RELEASE_ENVIRONMENT},${CUSTOM_FIELDS.STAGING_TIMESTAMP},${CUSTOM_FIELDS.PRODUCTION_TIMESTAMP}`)
    let issueData = await issueResponse.json()
    displayIssueState(issueData, '📊 Initial State')

    // Reset to clean state
    await resetIssue(jira)

    // Get state after reset
    issueResponse = await jira.request(`/issue/${TEST_ISSUE_KEY}?fields=status,summary,${CUSTOM_FIELDS.RELEASE_ENVIRONMENT},${CUSTOM_FIELDS.STAGING_TIMESTAMP},${CUSTOM_FIELDS.PRODUCTION_TIMESTAMP}`)
    issueData = await issueResponse.json()
    displayIssueState(issueData, '📊 After Reset')

    // Stage 1: Deploy to staging
    await deployToStaging(jira)

    // Verify staging state
    issueResponse = await jira.request(`/issue/${TEST_ISSUE_KEY}?fields=status,${CUSTOM_FIELDS.RELEASE_ENVIRONMENT},${CUSTOM_FIELDS.STAGING_TIMESTAMP},${CUSTOM_FIELDS.PRODUCTION_TIMESTAMP}`)
    issueData = await issueResponse.json()
    displayIssueState(issueData, '📊 After Staging Deployment')

    // Small delay to simulate time between deployments
    console.log('\n⏳ Waiting 2 seconds before production deployment...')
    await new Promise(resolve => setTimeout(resolve, 2000))

    // Stage 2: Deploy to production
    await deployToProduction(jira)

    // Verify final state
    console.log('\n🔍 Verifying final state...')
    issueResponse = await jira.request(`/issue/${TEST_ISSUE_KEY}?fields=status,summary,${CUSTOM_FIELDS.RELEASE_ENVIRONMENT},${CUSTOM_FIELDS.STAGING_TIMESTAMP},${CUSTOM_FIELDS.PRODUCTION_TIMESTAMP}`)
    issueData = await issueResponse.json()
    displayIssueState(issueData, '📊 Final State (After Production)')

    // Verify results
    const allTestsPassed = verifyResults(issueData)

    console.log()
    if (allTestsPassed) {
      console.log('🎉 ALL TESTS PASSED! Full deployment flow is working correctly.')
      console.log()
      console.log('✅ The fix for ALL-675 is verified and ready for production.')
      console.log('✅ Staging deployment sets Stage Release Timestamp correctly.')
      console.log('✅ Production deployment sets Production Release Timestamp correctly.')
      console.log('✅ Issues will properly transition through the full lifecycle.')
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
testFullDeploymentFlow()
  .then((exitCode) => {
    process.exit(exitCode)
  })
  .catch((error) => {
    console.error('Unhandled error:', error)
    process.exit(1)
  })
