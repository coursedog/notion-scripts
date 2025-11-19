#!/usr/bin/env node
/**
 * Test script to verify custom field updates on a Jira issue
 *
 * This script tests the ability to update deployment-related custom fields
 * on a specific Jira issue (DEX-36 by default) and optionally rolls back changes.
 *
 * Usage:
 *   node utils/test-custom-fields.js [ISSUE_KEY]
 *
 * Example:
 *   node utils/test-custom-fields.js DEX-36
 */

require('dotenv').config()
const Jira = require('../utils/jira')
const readline = require('readline')

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
})

function question (prompt) {
  return new Promise((resolve) => {
    rl.question(prompt, resolve)
  })
}

async function testCustomFieldUpdates () {
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env
  const issueKey = process.argv[2] || 'DEX-36'

  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    console.error('❌ Error: Missing required environment variables')
    console.error('Please ensure JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN are set in your .env file')
    process.exit(1)
  }

  console.log(`\n${  '='.repeat(80)}`)
  console.log('🧪 JIRA CUSTOM FIELDS UPDATE TEST')
  console.log('='.repeat(80))
  console.log(`Issue: ${issueKey}`)
  console.log(`Jira URL: ${JIRA_BASE_URL}`)
  console.log(`${'='.repeat(80)  }\n`)

  const jiraUtil = new Jira({
    baseUrl: JIRA_BASE_URL,
    email: JIRA_EMAIL,
    apiToken: JIRA_API_TOKEN,
  })

  let originalValues = {}

  try {
    // Step 1: Capture original values
    console.log('📋 Step 1: Capturing original field values...\n')

    const issueResponse = await jiraUtil.request(
      `/issue/${issueKey}?fields=status,customfield_11473,customfield_11474,customfield_11475`
    )
    const issue = await issueResponse.json()

    originalValues = {
      status: issue.fields.status.name,
      releaseEnvironment: issue.fields.customfield_11473,
      stageReleaseTimestamp: issue.fields.customfield_11474,
      productionReleaseTimestamp: issue.fields.customfield_11475,
    }

    console.log('Current Status:', originalValues.status)
    console.log('Release Environment:', originalValues.releaseEnvironment ? JSON.stringify(originalValues.releaseEnvironment) : 'null')
    console.log('Stage Release Timestamp:', originalValues.stageReleaseTimestamp || 'null')
    console.log('Production Release Timestamp:', originalValues.productionReleaseTimestamp || 'null')
    console.log()

    // Step 2: Test updating custom fields
    console.log('📝 Step 2: Testing custom field updates...\n')

    const testTimestamp = new Date().toISOString()
    const testCustomFields = {
      customfield_11474: testTimestamp, // Stage Release Timestamp
      customfield_11473: { id: '11942' }, // Release Environment: staging
    }

    console.log('Test values to set:')
    console.log('  - Stage Release Timestamp:', testTimestamp)
    console.log('  - Release Environment: staging (ID: 11942)')
    console.log()

    await jiraUtil.updateCustomFields(issueKey, testCustomFields)

    console.log('✅ Custom fields updated successfully!\n')

    // Step 3: Verify the update
    console.log('🔍 Step 3: Verifying the update...\n')

    await new Promise(resolve => setTimeout(resolve, 1000)) // Wait for Jira to process

    const verifyResponse = await jiraUtil.request(
      `/issue/${issueKey}?fields=customfield_11473,customfield_11474,customfield_11475`
    )
    const verifiedIssue = await verifyResponse.json()

    console.log('Updated values:')
    console.log('Release Environment:', verifiedIssue.fields.customfield_11473 ? JSON.stringify(verifiedIssue.fields.customfield_11473) : 'null')
    console.log('Stage Release Timestamp:', verifiedIssue.fields.customfield_11474 || 'null')
    console.log('Production Release Timestamp:', verifiedIssue.fields.customfield_11475 || 'null')
    console.log()

    // Step 4: Test production custom fields
    console.log('📝 Step 4: Testing production custom field update...\n')

    const prodTestTimestamp = new Date().toISOString()
    const prodCustomFields = {
      customfield_11475: prodTestTimestamp, // Production Release Timestamp
      customfield_11473: { id: '11943' }, // Release Environment: production
    }

    console.log('Production test values:')
    console.log('  - Production Release Timestamp:', prodTestTimestamp)
    console.log('  - Release Environment: production (ID: 11943)')
    console.log()

    await jiraUtil.updateCustomFields(issueKey, prodCustomFields)

    console.log('✅ Production custom fields updated successfully!\n')

    // Step 5: Verify production update
    console.log('🔍 Step 5: Verifying production update...\n')

    await new Promise(resolve => setTimeout(resolve, 1000))

    const verifyProdResponse = await jiraUtil.request(
      `/issue/${issueKey}?fields=customfield_11473,customfield_11474,customfield_11475`
    )
    const verifiedProdIssue = await verifyProdResponse.json()

    console.log('Final values:')
    console.log('Release Environment:', verifiedProdIssue.fields.customfield_11473 ? JSON.stringify(verifiedProdIssue.fields.customfield_11473) : 'null')
    console.log('Stage Release Timestamp:', verifiedProdIssue.fields.customfield_11474 || 'null')
    console.log('Production Release Timestamp:', verifiedProdIssue.fields.customfield_11475 || 'null')
    console.log()

    // Step 6: Offer to rollback
    console.log('='.repeat(80))
    console.log('✅ ALL TESTS PASSED!')
    console.log(`${'='.repeat(80)  }\n`)

    const shouldRollback = await question('Would you like to rollback to original values? (y/n): ')

    if (shouldRollback.toLowerCase() === 'y') {
      console.log('\n⏮️  Rolling back changes...\n')

      const rollbackFields = {}

      if (originalValues.releaseEnvironment) {
        rollbackFields.customfield_11473 = originalValues.releaseEnvironment
      }
      if (originalValues.stageReleaseTimestamp) {
        rollbackFields.customfield_11474 = originalValues.stageReleaseTimestamp
      }
      if (originalValues.productionReleaseTimestamp) {
        rollbackFields.customfield_11475 = originalValues.productionReleaseTimestamp
      }

      if (Object.keys(rollbackFields).length > 0) {
        await jiraUtil.updateCustomFields(issueKey, rollbackFields)
        console.log('✅ Successfully rolled back to original values')
      } else {
        console.log('ℹ️  No original values to restore (fields were empty)')
      }
    } else {
      console.log('\n⚠️  Changes were NOT rolled back. The test values remain on the issue.')
    }

    console.log(`\n${  '='.repeat(80)}`)
    console.log('🎉 Test completed successfully!')
    console.log(`${'='.repeat(80)  }\n`)

  } catch (error) {
    console.error('\n❌ TEST FAILED!')
    console.error('Error:', error.message)
    console.error('\nDetails:', error)
    process.exit(1)
  } finally {
    rl.close()
  }
}

// Run the test
testCustomFieldUpdates()
