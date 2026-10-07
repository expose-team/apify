import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { normalizeSearch, readConfig, runExpose, searchUrl } from './expose.js'

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('normalizeSearch', () => {
  it('keeps a person email and ignores a second identifier', () => {
    const result = normalizeSearch({ type: 'person', email: ' jane@example.com ', phone: '+14155551234' }, 0)
    assert.deepEqual(result, {
      type: 'person',
      field: 'email',
      identifier: 'jane@example.com',
      query: { email: 'jane@example.com' },
    })
  })

  it('uses a phone when the person has no email', () => {
    const result = normalizeSearch({ type: 'person', phone: '+14155551234' }, 0)
    assert.equal(result.query.phone, '+14155551234')
  })

  it('accepts profile_url as well as profileUrl', () => {
    const result = normalizeSearch({ type: 'company', profile_url: 'https://linkedin.com/company/stripe' }, 2)
    assert.equal(result.field, 'profile_url')
    assert.equal(result.identifier, 'https://linkedin.com/company/stripe')
  })

  it('prefers a domain for a school', () => {
    const result = normalizeSearch({ type: 'school', domain: 'mit.edu', profileUrl: 'https://example.com' }, 0)
    assert.deepEqual(result.query, { domain: 'mit.edu' })
  })

  it('rejects a person with no identifier', () => {
    const result = normalizeSearch({ type: 'person' }, 3)
    assert.match(result.error, /Search 4/)
    assert.match(result.error, /email, phone, or profile URL/)
  })

  it('rejects a company with no domain or profile URL', () => {
    const result = normalizeSearch({ type: 'company', email: 'jane@example.com' }, 0)
    assert.match(result.error, /domain or a profile URL/)
  })
})

describe('readConfig', () => {
  it('prefers the input key and falls back to the environment', () => {
    assert.equal(readConfig({ exposeApiKey: ' input ', searches: [{}] }, { EXPOSE_API_KEY: 'env' }).apiKey, 'input')
    assert.equal(readConfig({ searches: [] }, { EXPOSE_API_KEY: ' env ' }).apiKey, 'env')
  })
})

describe('searchUrl', () => {
  it('encodes a leading plus in a phone number', () => {
    const url = searchUrl('https://expose.team/', 'person', { phone: '+14155551234' })
    assert.equal(url, 'https://expose.team/api/search?type=person&phone=%2B14155551234')
  })
})

describe('runExpose', () => {
  it('stops before searching when the key is missing', async () => {
    let calls = 0
    const summary = await runExpose({
      apiKey: '',
      searches: [{ type: 'person', email: 'jane@example.com' }],
      fetchImpl: async () => {
        calls += 1
        return jsonResponse(200, {})
      },
    })
    assert.equal(calls, 0)
    assert.equal(summary.ok, false)
    assert.match(summary.reason, /API key/)
  })

  it('stops before searching when there are not enough credits', async () => {
    const urls = []
    const summary = await runExpose({
      apiKey: 'key',
      searches: [
        { type: 'person', email: 'jane@example.com' },
        { type: 'company', domain: 'stripe.com' },
      ],
      fetchImpl: async (url) => {
        urls.push(url)
        return jsonResponse(200, { credits: 1, renew_on: '2026-11-01', status: 'active' })
      },
    })
    assert.deepEqual(urls, ['https://expose.team/api/credits-status'])
    assert.match(summary.reason, /needs 2 credits/)
    assert.equal(summary.succeeded, 0)
  })

  it('writes one dataset item per search and sends the API key', async () => {
    const items = []
    const headers = []
    const summary = await runExpose({
      apiKey: 'secret-key',
      searches: [
        { type: 'person', email: 'jane@example.com' },
        { type: 'school' },
      ],
      baseUrl: 'https://expose.team',
      fetchImpl: async (url, init) => {
        headers.push(init.headers['x-api-key'])
        if (url.endsWith('/api/credits-status')) {
          return jsonResponse(200, { credits: 5, renew_on: '2026-11-01', status: 'active' })
        }
        return jsonResponse(200, { data: { name: 'Jane' } })
      },
      onItem: async item => items.push(item),
    })

    assert.equal(summary.ok, true)
    assert.equal(summary.succeeded, 1)
    assert.equal(summary.skipped, 1)
    assert.deepEqual(headers, ['secret-key', 'secret-key'])
    assert.equal(items[0].found, true)
    assert.equal(items[0].creditsCharged, 1)
    assert.deepEqual(items[0].report, { name: 'Jane' })
    assert.equal(items[1].ok, false)
    assert.equal(items[1].creditsCharged, 0)
  })

  it('stops the rest of the run when credits run out mid-way', async () => {
    const urls = []
    const summary = await runExpose({
      apiKey: 'key',
      searches: [
        { type: 'person', email: 'jane@example.com' },
        { type: 'company', domain: 'stripe.com' },
      ],
      fetchImpl: async (url) => {
        urls.push(url)
        if (url.endsWith('/api/credits-status')) {
          return jsonResponse(200, { credits: 2 })
        }
        return jsonResponse(402, { statusMessage: 'Out of credits' })
      },
    })
    assert.equal(urls.length, 2)
    assert.equal(summary.ok, false)
    assert.equal(summary.remaining, 1)
    assert.match(summary.reason, /Out of credits/)
  })

  it('rejects a bad API key before searching', async () => {
    const urls = []
    const summary = await runExpose({
      apiKey: 'nope',
      searches: [{ type: 'person', email: 'jane@example.com' }],
      fetchImpl: async (url) => {
        urls.push(url)
        return jsonResponse(401, { statusMessage: 'Not authenticated' })
      },
    })
    assert.equal(urls.length, 1)
    assert.match(summary.reason, /rejected/)
  })
})
