/**
 * Mention Watch — scan.js (v3: Tavily + Groq)
 *
 * Discovery: Tavily's search API, queried live on each run (not waiting
 * on Google Alerts' own crawl/notify schedule). Free tier: 1,000 credits
 * a month, no credit card, resets monthly. A basic search = 1 credit.
 *
 * Classification: Groq reads each NEW result's title + snippet (already
 * returned by Tavily, not searched by the AI) and returns a type,
 * sentiment, and one-line summary. Free tier: 14,400 requests/day.
 *
 * Every finding's URL comes directly from Tavily's search results — the
 * classification step never sees a blank page and invents a link.
 *
 * Requires: Node 18+ (built-in fetch), TAVILY_API_KEY and GROQ_API_KEY
 * env vars.
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!TAVILY_API_KEY) {
  console.error("Missing TAVILY_API_KEY environment variable.");
  process.exit(1);
}
if (!GROQ_API_KEY) {
  console.error("Missing GROQ_API_KEY environment variable.");
  process.exit(1);
}

// ---- Configuration -------------------------------------------------

const GROQ_MODEL = "openai/gpt-oss-120b"; // llama-3.3-70b-versatile was retired Aug 16, 2026
const DB_PATH = path.join(process.cwd(), "data", "findings.json");

const BRANDS = ["ZOP", "Afora"];

// One query per brand per run keeps monthly Tavily credit use well under
// the 1,000/month free cap. Add more phrasings later if you have headroom
// (check usage at app.tavily.com).
function queryFor(brand) {
  return `"${brand}" scam OR fraud OR complaints OR review OR "is it legit"`;
}

const CLASSIFY_INSTRUCTIONS = `
You are helping a company understand a single web search result about its
brand. You will be given a title and a short snippet from a real web page.
Do not search for anything or invent any information beyond what's given.

Respond with ONLY a JSON object with these fields:
- "type": one of "Complaint", "Review", "Scam claim", "Mention"
- "sentiment": one of "Positive", "Neutral", "Negative"
- "summary": ONE short sentence paraphrasing the snippet, in your own
  words. Do not quote it directly.
`.trim();

// ---- Tavily search -----------------------------------------------------

async function searchTavily(query) {
  const res = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      search_depth: "basic",
      max_results: 10,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Tavily request failed for "${query}": ${res.status} ${errText}`);
    return [];
  }

  const data = await res.json();
  return (data.results || []).map((r) => ({
    url: r.url,
    title: r.title || "",
    snippet: r.content || "",
  }));
}

function platformFromUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, "");
    if (host.includes("reddit.com")) return "Reddit";
    if (host.includes("trustpilot.com")) return "Trustpilot";
    if (host.includes("twitter.com") || host.includes("x.com")) return "X";
    if (host.includes("facebook.com")) return "Facebook";
    if (host.includes("instagram.com")) return "Instagram";
    if (host.includes("linkedin.com")) return "LinkedIn";
    return host;
  } catch {
    return "Web";
  }
}

// ---- Groq classification ----------------------------------------------

async function classify(title, snippet) {
  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: CLASSIFY_INSTRUCTIONS },
        { role: "user", content: `Title: ${title}\nSnippet: ${snippet}` },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Groq request failed: ${res.status} ${errText}`);
    return null;
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  try {
    return JSON.parse(text);
  } catch {
    console.error("Could not parse Groq output:", text.slice(0, 300));
    return null;
  }
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

function makeId(brand, url) {
  return `${brand}::${url}`;
}

// ---- Main --------------------------------------------------------------

async function main() {
  const existing = await loadFindings();
  const seenIds = new Set(existing.map((f) => f.id));
  const newFindings = [];

  for (const brand of BRANDS) {
    const query = queryFor(brand);
    console.log(`Searching: [${brand}] ${query}`);
    const results = await searchTavily(query);

    for (const result of results) {
      if (!result.url) continue;
      const id = makeId(brand, result.url);
      if (seenIds.has(id)) continue;

      const classified = await classify(result.title, result.snippet);
      if (!classified) continue;

      seenIds.add(id);
      newFindings.push({
        id,
        brand,
        platform: platformFromUrl(result.url),
        url: result.url,
        type: classified.type,
        sentiment: classified.sentiment,
        summary: classified.summary,
        foundAt: new Date().toISOString(),
      });

      // Stay well under Groq's per-minute rate limit.
      await new Promise((r) => setTimeout(r, 500));
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
