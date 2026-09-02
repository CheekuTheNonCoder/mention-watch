# Mention Watch — backend

Scheduled scanner that searches the web for mentions of ZOP and Afora using
Gemini + Google Search grounding, verifies every URL against Google's own
search results, and appends new findings to `data/findings.json`.

## How it enforces "never invent a source"

Gemini's grounded response comes back with two things: the model's text,
and `groundingMetadata` listing the exact URLs Google Search actually
returned. `scan.js` parses the model's JSON output but then **drops any
item whose URL isn't in that grounding metadata**. A finding only survives
if Google's own search results back it up.

## One-time setup

1. **Get a free Gemini API key**
   Go to [Google AI Studio](https://aistudio.google.com/apikey) and create
   a key. No credit card needed for the free tier.

2. **Create a GitHub repo** and push these files to it (or upload them
   through GitHub's web UI: create repo → "Add file" → "Upload files").

3. **Add your API key as a repo secret**
   In the repo: Settings → Secrets and variables → Actions → New repository
   secret. Name it `GEMINI_API_KEY`, paste your key as the value.

4. **Enable Actions**
   Go to the Actions tab in your repo and enable workflows if prompted.
   The workflow is already scheduled for every 3 hours
   (`.github/workflows/scan.yml`) — edit the `cron` line there if you want
   a different frequency.

5. **Test it manually first**
   In the Actions tab, select "Mention Watch Scan" → "Run workflow" to
   trigger it by hand and check `data/findings.json` updates correctly
   before waiting for the schedule.

## Editing what it searches for

Open `scan.js` and edit:
- `BRANDS` — the list of brand names to watch
- `queriesFor(brand)` — the search phrasings run per brand each cycle

## Free-tier limits to know

Google's grounded search pricing has changed a couple of times this year —
worth checking [ai.google.dev/gemini-api/docs/pricing](https://ai.google.dev/gemini-api/docs/pricing)
before relying on exact numbers. As of writing, `gemini-2.5-flash` gets a
real free daily allowance for grounded requests, and this schedule (2 brands
× 3 queries, every 3 hours ≈ 48 calls/day) sits comfortably inside it. If
you tighten the schedule a lot or add many more query phrasings, check your
usage in Google AI Studio to make sure you're still under the free cap.

## Connecting this to the dashboard

`data/findings.json` is the "database" from the architecture diagram. Once
this repo is public (or you're comfortable exposing just this file), the
dashboard can fetch it directly from:

```
https://raw.githubusercontent.com/<your-username>/<your-repo>/main/data/findings.json
```

and render the same fields the mock dashboard already expects: `brand`,
`platform`, `type`, `sentiment`, `summary`, `url`, `foundAt`.
