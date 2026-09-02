/**
 * Mention Watch — scan.js
 *
 * Runs one grounded-search pass per brand/query, asks Gemini to describe
 * what it found, and saves each finding ONLY if its URL is one that Google
 * Search actually returned (checked against groundingMetadata). Nothing
 * here is allowed to invent a source.
 *
 * Requires: Node 18+ (built-in fetch), GEMINI_API_KEY env var.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error("Missing GEMINI_API_KEY environment variable.");
  process.exit(1);
}

// ---- Configuration -------------------------------------------------

const MODEL = "gemini-3.6-flash"; // gemini-2.5-flash was retired for new API users
const DB_PATH = path.join(process.cwd(), "data", "findings.json");

const BRANDS = ["ZOP", "Afora"];

// One combined query per brand keeps daily API call volume low, which
// matters on Google's free tier (small daily request cap before billing
// is linked). Add more phrasings later if you have quota headroom.
function queriesFor(brand) {
  return [`"${brand}" scam OR fraud OR complaints OR review OR "is it legit"`];
}

const ANALYSIS_INSTRUCTIONS = `
You are helping a company monitor public mentions of its brand.

Search for recent, real, public posts, reviews, complaints, or articles
that match the query. For EACH distinct web page you find, output one
JSON object with these fields:

- "url": the exact URL of the page (must be a real page you found via search)
- "platform": short platform name, e.g. "Reddit", "Trustpilot", "X", "Blog",
  "Facebook", "Instagram", "LinkedIn", "News"
- "type": one of "Complaint", "Review", "Scam claim", "Mention"
- "sentiment": one of "Positive", "Neutral", "Negative"
- "summary": ONE short sentence paraphrasing what the post says, in your
  own words. Do not quote the source text directly.

Rules:
- Only include a page if you actually found it through search just now.
- Never invent, guess, or reconstruct a URL. If you're not sure a URL is
  real, leave that page out entirely.
- If nothing relevant was found, return an empty array.
- Respond with ONLY a JSON array. No markdown fences, no commentary.
`.trim();

// ---- Gemini call -----------------------------------------------------

async function runGroundedQuery(brand, query) {
  const body = {
    contents: [
      {
        parts: [{ text: `${ANALYSIS_INSTRUCTIONS}\n\nBrand: ${brand}\nQuery: ${query}` }],
      },
    ],
    tools: [{ google_search: {} }],
    generationConfig: {
      // Grounded calls on this model default to "thinking" on, which costs
      // more and has been reported to occasionally truncate the JSON output.
      thinkingConfig: { thinkingBudget: 0 },
    },
  };

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_API_KEY,
      },
      body: JSON.stringify(body),
    }
  );

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Gemini request failed for "${query}": ${res.status} ${errText}`);
    return [];
  }

  const data = await res.json();
  const candidate = data.candidates?.[0];
  if (!candidate) return [];

  const text = candidate.content?.parts?.map((p) => p.text || "").join("") || "";
  const groundedUrls = new Set(
    (candidate.groundingMetadata?.groundingChunks || [])
      .map((c) => c.web?.uri)
      .filter(Boolean)
  );

  let parsed;
  try {
    let cleaned = text.replace(/```json|```/g, "").trim();
    // Defend against responses that have stray text before/after the array,
    // or a truncated opening bracket, by slicing to the outermost [ ... ].
    const start = cleaned.indexOf("[");
    const end = cleaned.lastIndexOf("]");
    if (start === -1 || end === -1 || end < start) {
      throw new Error("no JSON array found in response");
    }
    cleaned = cleaned.slice(start, end + 1);
    parsed = JSON.parse(cleaned);
  } catch (err) {
    console.error(`Could not parse model output for "${query}":`, text.slice(0, 300));
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  // Hard enforcement: drop anything whose URL wasn't actually in Google's
  // own grounding results for this call.
  const verified = parsed.filter((item) => {
    if (!item?.url) return false;
    const ok = groundedUrls.has(item.url);
    if (!ok) {
      console.warn(`Dropping unverified URL (not in grounding results): ${item.url}`);
    }
    return ok;
  });

  return verified.map((item) => ({
    ...item,
    brand,
    foundAt: new Date().toISOString(),
  }));
}

// ---- Database (JSON file) --------------------------------------------

async function loadFindings() {
  try {
    const raw = await readFile(DB_PATH, "utf-8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function saveFindings(findings) {
  await mkdir(path.dirname(DB_PATH), { recursive: true });
  await writeFile(DB_PATH, JSON.stringify(findings, null, 2));
}

function makeId(finding) {
  return `${finding.brand}::${finding.url}`;
}

// ---- Main --------------------------------------------------------------

async function main() {
  const existing = await loadFindings();
  const seenIds = new Set(existing.map(makeId));
  const newFindings = [];

  for (const brand of BRANDS) {
    for (const query of queriesFor(brand)) {
      console.log(`Searching: [${brand}] ${query}`);
      const results = await runGroundedQuery(brand, query);
      for (const finding of results) {
        const id = makeId(finding);
        if (!seenIds.has(id)) {
          seenIds.add(id);
          newFindings.push({ id, ...finding });
        }
      }
      // Small delay to stay well under per-minute rate limits.
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  if (newFindings.length === 0) {
    console.log("No new findings this run.");
    return;
  }

  const updated = [...existing, ...newFindings];
  await saveFindings(updated);
  console.log(`Saved ${newFindings.length} new finding(s). Total: ${updated.length}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
