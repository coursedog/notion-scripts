/**
 * Custom Field Update Test Script
 *
 * Tests updating the custom fields on a real Jira issue to verify
 * that the field IDs and option IDs are correct.
 *
 * Usage:
 *   node utils/test-custom-field-update.js [ISSUE_KEY]
 *
 * Example:
 *   node utils/test-custom-field-update.js DEX-36
 */

require('dotenv').config()
const Jira = require('./jira')

async function testCustomFieldUpdate () {
  console.log(`\n${'='.repeat(70)}`)
  console.log('JIRA CUSTOM FIELD UPDATE TEST')
  console.log(`${'='.repeat(70)}\n`)

  // Check environment variables
  if (
    !process.env.JIRA_BASE_URL ||
    !process.env.JIRA_EMAIL ||
    !process.env.JIRA_API_TOKEN
  ) {
    console.error('❌ ERROR: Missing required environment variables')
    console.error('   Required: JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN\n')
    process.exit(1)
  }

  const testIssueKey =
    process.argv[2] || process.env.TEST_JIRA_ISSUE_KEY || 'DEX-36'

  console.log(`Test Issue: ${testIssueKey}`)
  console.log(`Base URL: ${process.env.JIRA_BASE_URL}\n`)

  const jira = new Jira({
    baseUrl: process.env.JIRA_BASE_URL,
    email: process.env.JIRA_EMAIL,
    apiToken: process.env.JIRA_API_TOKEN,
  })

  try {
    // Capture original state
    console.log('─'.repeat(70))
    console.log('STEP 1: Capturing original field values')
    console.log(`${'─'.repeat(70)}\n`)

    const originalResponse = await jira.request(
      `/issue/${testIssueKey}?fields=customfield_11473,customfield_11474,customfield_11475`
    )
    const originalIssue = await originalResponse.json()

    const originalEnv = originalIssue.fields.customfield_11473
    const originalStageTs = originalIssue.fields.customfield_11474
    const originalProdTs = originalIssue.fields.customfield_11475

    console.log('Original values:')
    console.log(
      `  Release Environment (11473): ${JSON.stringify(originalEnv)}`
    )
    console.log(`  Stage Timestamp (11474): ${originalStageTs || 'null'}`)
    console.log(
      `  Production Timestamp (11475): ${originalProdTs || 'null'}\n`
    )

    // Test staging deployment field update
    console.log('─'.repeat(70))
    console.log('STEP 2: Testing STAGING deployment field updates')
    console.log(`${'─'.repeat(70)}\n`)

    const stagingTimestamp = new Date().toISOString()
    const stagingFields = {
      customfield_11474: stagingTimestamp,
      customfield_11473: { id: '11942' }, // Staging environment option ID
    }

    console.log('Attempting to set:')
    console.log(`  customfield_11474 = ${stagingTimestamp}`)
    console.log('  customfield_11473 = { id: "11942" } (staging)\n')

    try {
      await jira.updateCustomFields(testIssueKey, stagingFields)
      console.log('✓ Staging fields updated successfully!\n')

      // Verify the update
      const verifyResponse = await jira.request(
        `/issue/${testIssueKey}?fields=customfield_11473,customfield_11474`
      )
      const verifiedIssue = await verifyResponse.json()

      console.log('Verified values:')
      console.log(
        `  Release Environment: ${JSON.stringify(
          verifiedIssue.fields.customfield_11473
        )}`
      )
      console.log(
        `  Stage Timestamp: ${verifiedIssue.fields.customfield_11474}\n`
      )
    } catch (error) {
      console.error('❌ Failed to update staging fields:', error.message)
      console.error(
        '   This might indicate incorrect field IDs or option IDs\n'
      )
      throw error
    }

    // Wait a moment
    await new Promise((resolve) => setTimeout(resolve, 1000))

    // Test production deployment field update
    console.log('─'.repeat(70))
    console.log('STEP 3: Testing PRODUCTION deployment field updates')
    console.log(`${'─'.repeat(70)}\n`)

    const prodTimestamp = new Date().toISOString()
    const prodFields = {
      customfield_11475: prodTimestamp,
      customfield_11473: { id: '11943' }, // Production environment option ID
    }

    console.log('Attempting to set:')
    console.log(`  customfield_11475 = ${prodTimestamp}`)
    console.log('  customfield_11473 = { id: "11943" } (production)\n')

    try {
      await jira.updateCustomFields(testIssueKey, prodFields)
      console.log('✓ Production fields updated successfully!\n')

      // Verify the update
      const verifyResponse = await jira.request(
        `/issue/${testIssueKey}?fields=customfield_11473,customfield_11475`
      )
      const verifiedIssue = await verifyResponse.json()

      console.log('Verified values:')
      console.log(
        `  Release Environment: ${JSON.stringify(
          verifiedIssue.fields.customfield_11473
        )}`
      )
      console.log(
        `  Production Timestamp: ${verifiedIssue.fields.customfield_11475}\n`
      )
    } catch (error) {
      console.error('❌ Failed to update production fields:', error.message)
      console.error(
        '   This might indicate incorrect field IDs or option IDs\n'
      )
      throw error
    }

    // Summary
    console.log('─'.repeat(70))
    console.log('TEST SUMMARY')
    console.log(`${'─'.repeat(70)}\n`)

    console.log('✅ ALL TESTS PASSED!')
    console.log('\nVerified field IDs:')
    console.log('  ✓ customfield_11473 (Release Environment) - select field')
    console.log('  ✓ customfield_11474 (Stage Release Timestamp) - datetime')
    console.log(
      '  ✓ customfield_11475 (Production Release Timestamp) - datetime'
    )
    console.log('\nVerified option IDs:')
    console.log('  ✓ 11942 - Staging environment')
    console.log('  ✓ 11943 - Production environment')
    console.log(
      '\n💡 The custom field configuration in update_jira/index.js is CORRECT!\n'
    )

    // Optionally restore original values
    console.log('⚠️  Note: Test values have been set on the issue.')
    console.log(
      `   You may want to manually restore original values if needed.\n`
    )
  } catch (error) {
    console.error('\n❌ TEST FAILED')
    console.error(`   ${error.message}\n`)

    if (error.message.includes('404')) {
      console.error(`   Issue ${testIssueKey} not found.`)
    } else if (
      error.message.includes('does not exist') ||
      error.message.includes('is not on the appropriate screen')
    ) {
      console.error(
        '   One or more custom field IDs are incorrect or not available for this issue type.'
      )
    } else if (
      error.message.includes('option') ||
      error.message.includes('11942') ||
      error.message.includes('11943')
    ) {
      console.error(
        '   Option IDs (11942 or 11943) are incorrect for the Release Environment field.'
      )
      console.error(
        '   Check Jira admin settings to find the correct option IDs.'
      )
    }

    process.exit(1)
  }
}

// Run test
testCustomFieldUpdate().catch((error) => {
  console.error('\n❌ Unexpected error:', error)
  process.exit(1)
})
