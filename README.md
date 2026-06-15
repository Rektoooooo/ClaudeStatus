# Claude Status → Discord Bot

Posts an alert to a Discord channel whenever https://status.claude.com reports a
new incident, an update, or a resolution. Runs free on GitHub Actions every 5 minutes.

## How it works

1. GitHub Actions runs `monitor.js` every 5 minutes.
2. The script fetches `https://status.claude.com/api/v2/summary.json`.
3. It diffs the current incidents against `state.json` (the last-seen state).
4. For each change it posts a color-coded embed to your Discord webhook:
   - 🔴 **Red** — new incident / investigating
   - 🟠 **Orange** — monitoring
   - 🟢 **Green** — resolved
5. New incidents `@everyone`; follow-up updates and resolves post silently.
6. The updated `state.json` is committed back to the repo so the next run remembers.

## Setup

### 1. Create a Discord webhook
In your Discord server: **Edit Channel → Integrations → Webhooks → New Webhook → Copy Webhook URL**.

### 2. Push this repo to GitHub (public, so Actions is free)

### 3. Add the webhook as a secret
Repo **Settings → Secrets and variables → Actions → New repository secret**:
- Name: `DISCORD_WEBHOOK_URL`
- Value: *(the webhook URL)*

### 4. Enable Actions
Go to the **Actions** tab and enable workflows. It now runs every 5 minutes.
Use **Run workflow** (from `workflow_dispatch`) to trigger a test run manually.

## Local testing

```bash
# Post current incidents to your webhook:
DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..." node monitor.js

# Seed state.json from current incidents WITHOUT posting anything:
SEED=1 node monitor.js
```

## Cost
Free. GitHub Actions (public repo) + Discord webhooks cost nothing.

## Notes
- Requires Node 20+ (uses the built-in global `fetch`). Zero npm dependencies.
- GitHub Actions cron can be delayed 5–20 min during peak load — acceptable for status alerts.
