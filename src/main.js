import { Actor } from 'apify'

import { readConfig, runExpose } from './expose.js'

await Actor.main(async () => {
  const input = (await Actor.getInput()) ?? {}
  const { apiKey, searches } = readConfig(input, process.env)
  const summary = await runExpose({
    apiKey,
    searches,
    onItem: item => Actor.pushData(item),
  })
  await Actor.setValue('SUMMARY', summary)
  if (!summary.ok) {
    throw new Error(summary.reason || 'Expose search failed.')
  }
})
