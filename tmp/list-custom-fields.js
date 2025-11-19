#!/usr/bin/env node
/**
 * List all custom fields in your Jira instance
 *
 * This script helps you discover the correct custom field IDs for your Jira instance.
 * Run: node utils/list-custom-fields.js
 */

require('dotenv').config()
const Jira = require('../utils/jira')

async function listAllCustomFields () {
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env

  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    console.error('Error: Missing required environment variables')
    console.error('Please ensure JIRA_BASE_URL, JIRA_EMAIL, and JIRA_API_TOKEN are set in your .env file')
    process.exit(1)
  }

  const jiraUtil = new Jira({
    baseUrl: JIRA_BASE_URL,
    email: JIRA_EMAIL,
    apiToken: JIRA_API_TOKEN,
  })

  try {
    console.log('Fetching all custom fields from Jira...\n')

    const response = await jiraUtil.request('/field')
    const fields = await response.json()

    // Filter for custom fields only
    const customFields = fields.filter(field => field.id.startsWith('customfield_'))

    console.log(`Found ${customFields.length} custom fields:\n`)
    console.log('=' .repeat(100))

    // Group by name patterns we're looking for
    const releaseFields = customFields.filter(f =>
      f.name.toLowerCase().includes('release') ||
      f.name.toLowerCase().includes('environment') ||
      f.name.toLowerCase().includes('timestamp') ||
      f.name.toLowerCase().includes('deploy')
    )

    if (releaseFields.length > 0) {
      console.log('\n🎯 RELEASE/DEPLOYMENT RELATED FIELDS:')
      console.log('=' .repeat(100))
      releaseFields.forEach(field => {
        console.log(`ID: ${field.id}`)
        console.log(`Name: ${field.name}`)
        console.log(`Type: ${field.schema?.type || 'unknown'}`)
        console.log(`Custom: ${field.schema?.custom || 'N/A'}`)
        console.log('-'.repeat(100))
      })
    }

    console.log('\n📋 ALL CUSTOM FIELDS:')
    console.log('=' .repeat(100))
    customFields.forEach(field => {
      console.log(`${field.id.padEnd(20)} | ${field.name.padEnd(40)} | ${field.schema?.type || 'unknown'}`)
    })

    // Check specifically for the fields we're trying to use
    console.log('\n\n🔍 CHECKING FOR EXPECTED FIELDS:')
    console.log('=' .repeat(100))
    const expectedFields = [
      { id: 'customfield_11473', name: 'Release Environment' },
      { id: 'customfield_11474', name: 'Stage Release Timestamp' },
      { id: 'customfield_11475', name: 'Production Release Timestamp' },
    ]

    expectedFields.forEach(expected => {
      const found = customFields.find(f => f.id === expected.id)
      if (found) {
        console.log(`✅ ${expected.id} - Found: "${found.name}"`)
      } else {
        console.log(`❌ ${expected.id} - NOT FOUND (expected: "${expected.name}")`)
      }
    })

  } catch (error) {
    console.error('Error fetching custom fields:', error.message)
    process.exit(1)
  }
}

listAllCustomFields()
