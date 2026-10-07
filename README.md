# Expose Search

Search people, companies, and schools on [Expose](https://expose.team) and save each report to the dataset.

One valid row uses one Expose credit. The credit is billed on your Expose account, through the API key you provide. Apify does not see that key in the dataset.

## What you need

- An Expose account with credits. Copy the API key from [Integrations](https://expose.team/platform/integrations).
- An identifier Expose can search:
  - Person: email, phone (with country code), or profile URL.
  - Company or school: domain or profile URL.

A name alone is not a search.

## Input

| Field | Required | Description |
| --- | --- | --- |
| Expose API key | Yes, unless `EXPOSE_API_KEY` is set | Your key. Apify stores this field encrypted. |
| Searches | Yes | One object per search. |

```json
{
  "exposeApiKey": "YOUR_API_KEY",
  "searches": [
    { "type": "person", "email": "jane@example.com" },
    { "type": "person", "phone": "+14155551234" },
    { "type": "company", "domain": "stripe.com" },
    { "type": "school", "domain": "mit.edu" }
  ]
}
```

When a row has more than one identifier, the Actor sends the first match in this order: email, phone, profile URL for a person; domain, then profile URL for a company or school. Use a second row to search another identifier. That second row spends another credit.

The Actor checks the credit balance first. If the account does not have a credit for every valid row, it stops and does not start the searches.

## Output

Each row becomes one dataset item:

| Field | Meaning |
| --- | --- |
| `type` | `person`, `company`, or `school` |
| `identifier` | The value that was searched |
| `identifierField` | `email`, `phone`, `profile_url`, or `domain` |
| `ok` | Expose accepted the search |
| `found` | The report object is not empty |
| `creditsCharged` | `1` when Expose charged this row |
| `error` | Why the row failed |
| `report` | The `data` object from `GET /api/search` |

Open an item to read the report. The run's key-value store also has a `SUMMARY` record with succeeded, failed, and skipped counts.

A row that fails validation is stored with `creditsCharged: 0` and the rest of the run continues. If Expose returns 401 or 402 during the run, the Actor stops so later rows are not sent.

## Call it from another Actor

```javascript
import { Actor } from 'apify';

const run = await Actor.call('expose/expose-search', {
  exposeApiKey: process.env.EXPOSE_API_KEY,
  searches: [{ type: 'person', email: 'jane@example.com' }],
});
const dataset = await Actor.apifyClient.dataset(run.defaultDatasetId).listItems();
```

Do not put a shared Expose API key in the environment of a public Actor. Each user should paste their own key. `EXPOSE_API_KEY` is for a private Actor that only your account runs.

## Data sent to Expose

The Actor sends the API key and the identifiers to `https://expose.team`. It does not browse the web and it does not use an Apify proxy. Reports contain publicly available information returned by Expose.
