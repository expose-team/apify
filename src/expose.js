const DEFAULT_BASE_URL = 'https://expose.team'

export function clean(value) {
  if (typeof value !== 'string') return ''
  return value.trim()
}

/**
 * One search sends one identifier. Person prefers email, then phone, then profile URL.
 * Company and school prefer domain, then profile URL.
 */
export function normalizeSearch(raw, index) {
  const label = `Search ${index + 1}`
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `${label} must be an object.` }
  }

  const type = raw.type
  if (type !== 'person' && type !== 'company' && type !== 'school') {
    return { error: `${label} needs type person, company, or school.` }
  }

  const email = clean(raw.email)
  const phone = clean(raw.phone)
  const profileUrl = clean(raw.profileUrl ?? raw.profile_url)
  const domain = clean(raw.domain)

  let field
  let identifier
  if (type === 'person') {
    if (email) {
      field = 'email'
      identifier = email
    } else if (phone) {
      field = 'phone'
      identifier = phone
    } else if (profileUrl) {
      field = 'profile_url'
      identifier = profileUrl
    } else {
      return { error: `${label} is a person and needs an email, phone, or profile URL.` }
    }
  } else if (domain) {
    field = 'domain'
    identifier = domain
  } else if (profileUrl) {
    field = 'profile_url'
    identifier = profileUrl
  } else {
    return { error: `${label} is a ${type} and needs a domain or a profile URL.` }
  }

  return { type, field, identifier, query: { [field]: identifier } }
}

export function readConfig(input = {}, env = {}) {
  const source = input && typeof input === 'object' ? input : {}
  const apiKey = clean(source.exposeApiKey) || clean(env.EXPOSE_API_KEY)
  const searches = Array.isArray(source.searches) ? source.searches : []
  return { apiKey, searches }
}

export function searchUrl(baseUrl, type, query) {
  const root = baseUrl.replace(/\/$/, '')
  const params = new URLSearchParams({ type, ...query })
  return `${root}/api/search?${params.toString()}`
}

function creditsUrl(baseUrl) {
  return `${baseUrl.replace(/\/$/, '')}/api/credits-status`
}

async function readBody(response) {
  const text = await response.text()
  if (!text) return { json: null, text: '' }
  try {
    return { json: JSON.parse(text), text }
  } catch {
    return { json: null, text }
  }
}

function messageFrom(status, body) {
  const json = body?.json
  const fromJson = json?.statusMessage || json?.message || json?.statusText
  if (typeof fromJson === 'string' && fromJson.trim()) return fromJson.trim()
  if (body?.text) return body.text.slice(0, 300)
  return `Expose returned HTTP ${status}`
}

function itemFrom(normalized, { ok, statusCode, error, creditsCharged, report }) {
  return {
    type: normalized.type,
    identifier: normalized.identifier,
    identifierField: normalized.field,
    ok,
    found: Boolean(report && typeof report === 'object' && Object.keys(report).length > 0),
    statusCode,
    error,
    creditsCharged,
    report,
  }
}

async function request(fetchImpl, url, apiKey) {
  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { 'x-api-key': apiKey, accept: 'application/json' },
      signal: AbortSignal.timeout(120_000),
    })
  } catch (error) {
    const message = error?.name === 'TimeoutError' ? 'Expose did not respond within 120 seconds.' : 'Could not reach Expose.'
    return { ok: false, statusCode: 0, error: message, body: null }
  }
  const body = await readBody(response)
  if (!response.ok) {
    return { ok: false, statusCode: response.status, error: messageFrom(response.status, body), body }
  }
  return { ok: true, statusCode: response.status, error: null, body }
}

export async function runExpose({
  apiKey,
  searches,
  fetchImpl = fetch,
  baseUrl = DEFAULT_BASE_URL,
  onItem,
}) {
  const empty = { ok: false, succeeded: 0, failed: 0, skipped: 0, remaining: 0 }

  if (!apiKey) {
    return { ...empty, reason: 'Missing Expose API key. Paste it into Expose API key, or set EXPOSE_API_KEY on the Actor.' }
  }
  if (!Array.isArray(searches) || searches.length === 0) {
    return { ...empty, reason: 'Add at least one search.' }
  }

  const prepared = searches.map((raw, index) => normalizeSearch(raw, index))
  const billable = prepared.filter(entry => !entry.error)
  if (billable.length === 0) {
    return { ...empty, skipped: prepared.length, reason: prepared[0].error }
  }

  const credits = await request(fetchImpl, creditsUrl(baseUrl), apiKey)
  if (!credits.ok) {
    const reason = credits.statusCode === 401
      ? 'The Expose API key was rejected.'
      : credits.error
    return { ...empty, reason }
  }

  const available = credits.body?.json?.credits
  if (typeof available !== 'number') {
    return { ...empty, reason: 'Expose did not return a credit balance.' }
  }
  if (available < billable.length) {
    return {
      ...empty,
      reason: `This run needs ${billable.length} credits and the account has ${available}.`,
    }
  }

  let succeeded = 0
  let failed = 0
  let skipped = 0

  for (let index = 0; index < prepared.length; index++) {
    const entry = prepared[index]
    if (entry.error) {
      skipped += 1
      await onItem?.({
        type: searches[index]?.type ?? null,
        identifier: null,
        identifierField: null,
        ok: false,
        found: false,
        statusCode: 400,
        error: entry.error,
        creditsCharged: 0,
        report: null,
      })
      continue
    }

    const result = await request(fetchImpl, searchUrl(baseUrl, entry.type, entry.query), apiKey)
    const charged = result.statusCode !== 0 && result.statusCode !== 400 && result.statusCode !== 401 && result.statusCode !== 402
    const report = result.ok ? (result.body?.json?.data ?? result.body?.json ?? null) : null
    const datasetItem = itemFrom(entry, {
      ok: result.ok,
      statusCode: result.statusCode,
      error: result.error,
      creditsCharged: charged ? 1 : 0,
      report,
    })
    await onItem?.(datasetItem)

    if (result.statusCode === 401 || result.statusCode === 402) {
      failed += 1
      const remaining = prepared.length - index - 1
      return {
        ok: false,
        reason: `${result.error} Finished ${succeeded} searches and stopped with ${remaining} left.`,
        succeeded,
        failed,
        skipped,
        remaining,
      }
    }

    if (result.ok) succeeded += 1
    else failed += 1
  }

  return {
    ok: failed === 0,
    reason: failed === 0 ? null : `${failed} searches failed. The dataset has one row per search.`,
    succeeded,
    failed,
    skipped,
    remaining: 0,
  }
}
