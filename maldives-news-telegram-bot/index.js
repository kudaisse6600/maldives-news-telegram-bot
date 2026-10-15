require("dotenv").config();

const fs = require("node:fs/promises");
const path = require("node:path");
const Parser = require("rss-parser");

const parser = new Parser({
  timeout: 20000,
  headers: { "User-Agent": "MaldivesNewsTelegramBot/1.0 (RSS reader; contact channel admin)" }
});

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;
const FEEDS = (process.env.RSS_FEEDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const POLL_INTERVAL_MS = Math.max(60_000, Number(process.env.POLL_INTERVAL_MS || 300000));
const MAX_PER_FEED = Math.max(1, Number(process.env.MAX_POSTS_PER_FEED_PER_CHECK || 5));
const DEDUPE_FILE = process.env.DEDUPE_FILE || path.join(__dirname, "data", "seen.json");
const MAX_AGE_DAYS = Math.max(0, Number(process.env.MAX_AGE_DAYS || 3));
const MAX_SEEN = 5000;

if (!BOT_TOKEN || !CHANNEL_ID || FEEDS.length === 0) {
  console.error("Missing required config. Set TELEGRAM_BOT_TOKEN, TELEGRAM_CHANNEL_ID and RSS_FEEDS.");
  process.exit(1);
}

let isChecking = false;
let seen = new Set();

function cleanText(value = "") {
  return String(value)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function getItemUrl(item) {
  const url = item.link || item.guid || item.id || "";
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) return "";
    return parsed.href;
  } catch {
    return "";
  }
}

function getPublisher(feed, item, url) {
  if (feed.title) return cleanText(feed.title);
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return "Maldives news source"; }
}

function itemKey(item, url) {
  // Prefer the canonical article link; fall back to GUID/title only if needed.
  return url || String(item.guid || item.id || item.title || "").trim();
}

function isTooOld(item) {
  if (!MAX_AGE_DAYS) return false;
  const raw = item.isoDate || item.pubDate || item.date;
  if (!raw) return false;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return false;
  return Date.now() - date.getTime() > MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
}

async function loadSeen() {
  try {
    const parsed = JSON.parse(await fs.readFile(DEDUPE_FILE, "utf8"));
    seen = new Set(Array.isArray(parsed) ? parsed : []);
    console.log(`Loaded ${seen.size} previously seen stories.`);
  } catch (error) {
    if (error.code !== "ENOENT") console.warn("Could not read dedupe file:", error.message);
    seen = new Set();
  }
}

async function saveSeen() {
  await fs.mkdir(path.dirname(DEDUPE_FILE), { recursive: true });
  const values = [...seen].slice(-MAX_SEEN);
  const tempFile = `${DEDUPE_FILE}.tmp`;
  await fs.writeFile(tempFile, JSON.stringify(values, null, 2), "utf8");
  await fs.rename(tempFile, DEDUPE_FILE);
}

async function telegramSend(text) {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: CHANNEL_ID,
      text,
      disable_web_page_preview: false
    })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data.ok) {
    throw new Error(`Telegram sendMessage failed: ${data.description || response.statusText}`);
  }
  return data.result;
}

async function makeBilingualSummary(title, description, publisher) {
  const sourceText = cleanText(description).slice(0, 3500);
  if (!process.env.OPENAI_API_KEY) {
    return sourceText
      ? `Summary / ޚުލާސާ:\n${sourceText.slice(0, 650)}`
      : "Summary / ޚުލާސާ: Open the original article for details.";
  }

  const prompt = [
    "You are a careful bilingual news editor for a Maldives news Telegram channel.",
    "Use only the supplied headline and description. Do not add facts, names, quotes, dates, or claims not present in the source.",
    "Write a concise summary in English AND natural Dhivehi written in Thaana script.",
    "If the source text is in only one language, translate faithfully into the other language.",
    "If the text is too vague, say that the source has limited details rather than guessing.",
    "Output exactly these labels on separate lines: English: ... and ދިވެހި: ...",
    "Keep the entire response under 700 characters.",
    `Publisher: ${publisher}`,
    `Headline: ${title}`,
    `Description: ${sourceText || "(No description provided)"}`
  ].join("\n\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
      messages: [
        { role: "system", content: "Summarize news accurately. Never invent missing details." },
        { role: "user", content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 350
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI summary failed (${response.status}): ${body.slice(0, 300)}`);
  }
  const data = await response.json();
  return cleanText(data.choices?.[0]?.message?.content || "") || sourceText.slice(0, 650);
}

function buildPost({ title, summary, publisher, url, publishedAt }) {
  const safeTitle = cleanText(title) || "News update";
  const time = publishedAt && !Number.isNaN(new Date(publishedAt).getTime())
    ? new Date(publishedAt).toLocaleString("en-GB", { timeZone: "Indian/Maldives", dateStyle: "medium", timeStyle: "short" })
    : "";
  return [
    `📰 ${safeTitle}`,
    "",
    summary,
    "",
    `Source: ${publisher}`,
    time ? `Published: ${time} (Maldives time)` : "",
    `Original article: ${url}`,
    "",
    "#MaldivesNews"
  ].filter(Boolean).join("\n");
}

async function checkFeeds() {
  if (isChecking) {
    console.log("Previous check still running; skipping this cycle.");
    return;
  }
  isChecking = true;
  try {
    for (const feedUrl of FEEDS) {
      try {
        console.log(`Checking feed: ${feedUrl}`);
        const feed = await parser.parseURL(feedUrl);
        const items = (feed.items || []).slice(0, 100);
        const publisher = cleanText(feed.title) || new URL(feedUrl).hostname;
        const fresh = [];

        for (const item of items) {
          const url = getItemUrl(item);
          const key = itemKey(item, url);
          if (!key || seen.has(key) || isTooOld(item)) continue;
          if (!cleanText(item.title) || !url) continue;
          fresh.push({ item, url, key });
        }

        // Feeds usually list newest first. Publish older unseen items first to keep order sensible.
        for (const entry of fresh.slice(0, MAX_PER_FEED).reverse()) {
          const { item, url, key } = entry;
          const title = cleanText(item.title);
          const description = cleanText(item.contentSnippet || item.summary || item.content || item.description || "");
          let summary;
          try {
            summary = await makeBilingualSummary(title, description, publisher);
          } catch (error) {
            console.error("Summary failed; using feed description:", error.message);
            summary = description
              ? `Summary / ޚުލާސާ:\n${description.slice(0, 650)}`
              : "Summary / ޚުލާސާ: Open the original article for details.";
          }

          const message = buildPost({
            title,
            summary,
            publisher,
            url,
            publishedAt: item.isoDate || item.pubDate
          });

          try {
            await telegramSend(message);
            seen.add(key);
            await saveSeen();
            console.log(`Published: ${title}`);
            await new Promise((resolve) => setTimeout(resolve, 1200));
          } catch (error) {
            console.error(`Could not publish "${title}":`, error.message);
            // Do not mark as seen when Telegram fails, so it can retry next cycle.
          }
        }
      } catch (error) {
        console.error(`Feed error (${feedUrl}):`, error.message);
      }
    }
  } finally {
    isChecking = false;
  }
}

async function main() {
  await loadSeen();
  console.log(`Maldives News Bot started. ${FEEDS.length} feeds; interval ${POLL_INTERVAL_MS}ms.`);
  await checkFeeds(); // first check immediately
  setInterval(checkFeeds, POLL_INTERVAL_MS);
}

process.on("SIGTERM", () => {
  console.log("SIGTERM received; shutting down.");
  process.exit(0);
});
process.on("SIGINT", () => process.exit(0));

main().catch((error) => {
  console.error("Fatal startup error:", error);
  process.exit(1);
});
