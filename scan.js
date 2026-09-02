/**
 * Mention Watch — scan.js
 *
 * Discovery: reads Google Alerts RSS/Atom feeds (one per brand). This has
 * no API quota — it's just a feed URL Google updates on its own schedule.
 *
 * Classification: sends each NEW alert's title + snippet (already fetched
 * from the feed, not searched by an AI) to Groq for a short summary,
 * sentiment, and type tag.
 *
 * The URL for every finding comes directly from the Google Alerts feed
 * entry itself — it is never generated or guessed by the AI step.
 *
 * Requires: Node 18+ (built-in fetch), GROQ_API_KEY env var,
 * the "fast-xml-parser" package (see package.json).
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";
import { XMLParser } from "fast-xml-parser";

const GROQ_API_KEY = process.env.GROQ_API_KEY;
if (!GROQ_API_KEY) {
  console.error("Missing GROQ_API_KEY environment variable.");
  process.exit(1);
}

// ---- Configuration -------------------------------------------------

const GROQ_MODEL = "llama-3.3-70b-versatile";
const DB_PATH = path.join(process.cwd(), "data", "findings.json");

// Paste the RSS feed URL for each brand's Google Alert here.
// (Google Alerts → edit an alert → "Deliver to" → "RSS Feed" → copy link.)
const FEEDS = {
  ZOP: "https://www.google.com/alerts/feeds/05813187493059511228/8592933093986867067",
  Afora: "https://www.google.com/alerts/feeds/05813187493059511228/8929181206387735148",
};

const CLASSIFY_INSTRUCTIONS = `
You are helping a company understand a single web mention of its brand.
You will be given a title and a short snippet from a real web page. Do not
search for anything or invent any information beyond what's given.

Respond with ONLY a JSON object with these fields:
- "type": one of "Complaint", "Review", "Scam claim", "Mention"
- "sentiment": one of "Positive", "Neutral", "Negative"
- "summary": ONE short sentence paraphrasing the snippet, in your own
  words. Do not quote it directly.
`.trim();

// ---- Google Alerts feed parsing --------------------------------------

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@_" });

function stripHtml(html) {
  return (html || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

// Google Alerts links wrap the real URL as a query parameter, e.g.
// https://www.google.com/url?rct=j&sa=t&url=<REAL_URL>&ct=ga&...
function unwrapGoogleUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const inner = parsed.searchParams.get("url") || parsed.searchParams.get("q");
    return inner || rawUrl;
  } catch {
    return rawUrl;
  }
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
    if (host.includes("news.google.com")) return "News";
    return host;
  } catch {
    return "Web";
  }
}

async function fetchAlertEntries(feedUrl) {
  const res = await fetch(feedUrl);
  if (!res.ok) {
    console.error(`Failed to fetch feed (${res.status}): ${feedUrl}`);
    return [];
  }
  const xml = await res.text();
  const parsed = xmlParser.parse(xml);

  // Google Alerts feeds are Atom format: <feed><entry>...</entry></feed>
  const entries = parsed?.feed?.entry;
  if (!entries) return [];
  const list = Array.isArray(entries) ? entries : [entries];

  return list.map((entry) => {
    const rawLink = Array.isArray(entry.link) ? entry.link[0] : entry.link;
    const href = rawLink?.["@_href"] || "";
    const url = unwrapGoogleUrl(href);
    const title = stripHtml(entry.title || "");
    const snippet = stripHtml(entry.content || entry.summary || "");
    const id = entry.id || url;
    return { id, url, title, snippet };
  });
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

function makeId(brand, entryId) {
  return `${brand}::${entryId}`;
}

// ---- Main --------------------------------------------------------------

async function main() {
  const existing = await loadFindings();
  const seenIds = new Set(existing.map((f) => f.id));
  const newFindings = [];

  for (const [brand, feedUrl] of Object.entries(FEEDS)) {
    if (feedUrl.startsWith("PASTE_YOUR_")) {
      console.warn(`Skipping ${brand}: no Google Alerts feed URL configured yet.`);
      continue;
    }

    console.log(`Checking feed for ${brand}...`);
    const entries = await fetchAlertEntries(feedUrl);

    for (const entry of entries) {
      const id = makeId(brand, entry.id);
      if (seenIds.has(id)) continue;
      if (!entry.url) continue;

      const result = await classify(entry.title, entry.snippet);
      if (!result) continue;

      seenIds.add(id);
      newFindings.push({
        id,
        brand,
        platform: platformFromUrl(entry.url),
        url: entry.url,
        type: result.type,
        sentiment: result.sentiment,
        summary: result.summary,
        foundAt: new Date().toISOString(),
      });

      // Stay well under Groq's rate limit.
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
