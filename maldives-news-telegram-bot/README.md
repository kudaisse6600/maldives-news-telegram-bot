# Maldives News Telegram Bot (Dhivehi + English)

A Node.js worker that checks RSS feeds every five minutes, summarizes each story in English and Dhivehi (Thaana) when an OpenAI API key is configured, and posts a source-attributed message to a Telegram channel.

## Important limitations

- It collects only from the RSS feeds configured in `RSS_FEEDS`. It does not magically cover every Maldivian newspaper.
- The starter config uses TNN's published RSS feeds. Add other publishers only after confirming their official RSS feed or permitted API.
- The bot posts a headline, a short summary, publisher credit, publication time when available, and a link to the original article. It does not copy full articles.
- For reliable bilingual summaries, set `OPENAI_API_KEY`. Without it, the bot uses the feed's description, which may be only in the source language.
- Render's normal filesystem is ephemeral. Attach a persistent disk mounted at `/var/data` to the worker or change to a persistent database, otherwise deduplication history can be lost during restarts/deploys.
- RSS feed structure and availability can change; monitor the Render logs.

## 1. Create a Telegram bot

1. Open Telegram and search for `@BotFather`.
2. Send `/newbot`, follow the prompts, and copy the bot token.
3. Open your existing news channel's settings and add the bot as an administrator with permission to post messages.
4. Use the channel's public username as `TELEGRAM_CHANNEL_ID`, for example `@YourChannelName`. For a private channel, use its numeric `-100...` chat ID instead.

Never publish your bot token or commit it to GitHub.

## 2. Create a GitHub repository

1. Create a new repository named `maldives-news-telegram-bot`.
2. Upload all files from this folder to the repository root.
3. Do not upload your real `.env` file or secrets.

## 3. Deploy to Render

1. In Render, choose **New + → Background Worker** and connect this repository.
2. Runtime: **Node**.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variables listed below.
6. Deploy the worker.

A background worker is the right Render service type because it runs continuously and does not need a public website URL.

### Required Render environment variables

- `TELEGRAM_BOT_TOKEN` — token from BotFather
- `TELEGRAM_CHANNEL_ID` — your channel username, e.g. `@YourChannelName`
- `RSS_FEEDS` — comma-separated RSS URLs
- `POLL_INTERVAL_MS` — `300000`
- `DEDUPE_FILE` — `/var/data/seen.json`
- `OPENAI_API_KEY` — your OpenAI API key, for bilingual summaries
- `OPENAI_MODEL` — `gpt-4.1-mini`
- `MAX_AGE_DAYS` — `3`
- `MAX_POSTS_PER_FEED_PER_CHECK` — `5`

## 4. Add persistent storage

In Render's service settings, add a persistent disk if available for your worker and mount it at `/var/data`. This preserves the seen-story list between restarts. If your Render plan does not support a disk for this service, use a persistent database before relying on the bot for production.

## 5. RSS sources

The included starter feeds are published by The News Nest (TNN):

- `https://tnn.mv/en/rss/latest-posts`
- `https://tnn.mv/en/rss/category/local-news`

TNN's RSS feed directory: https://tnn.mv/en/rss-feeds

Maizan Online also has an RSS feed directory: https://www.maizan.mv/en/rss-feeds. Open it and copy the exact feed URLs you want into `RSS_FEEDS`. Other publishers may not provide RSS feeds or may restrict automated use.

Example `RSS_FEEDS`:
`https://tnn.mv/en/rss/latest-posts,https://tnn.mv/en/rss/category/local-news,PASTE_ANOTHER_OFFICIAL_FEED_URL_HERE`

Remove the placeholder before deploying.

## 6. Test and verify

1. Check the Render worker logs. You should see `Maldives News Bot started`.
2. If Telegram returns `chat not found` or `not enough rights`, confirm the channel ID and bot administrator permissions.
3. Confirm a story is posted with its source and original article URL.
4. Wait five minutes and confirm it does not post the same URL twice.
5. If bilingual output is required, check that `OPENAI_API_KEY` is valid and the logs do not show summary errors.

## Run locally on a Mac

1. Install Node.js 20 or later.
2. In Terminal, enter the project folder.
3. Run `npm install`.
4. Copy `.env.example` to `.env` and fill in the real values.
5. Set `DEDUPE_FILE=./data/seen.json` for local testing.
6. Run `npm start`.

## Editorial safety

Use source headlines and short original summaries, attribute each publisher, and link to the original article. Respect each publisher's terms and robots/access rules. Check summaries before scaling up; machine translations can contain errors.
