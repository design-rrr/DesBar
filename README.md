# DesBar

Posts 4 links from [Sidebar.io](https://sidebar.io/) feed to the [Stacker.news](https://stacker.news) **~Design** territory every weekday, at a random time between 1am-3am UTC.

Each post includes:
- The original link
- Post title from Sidebar
- Description text from Sidebar
- Category hashtags from Sidebar (e.g. `#AI #UX #Design`)
- A screenshot of the destination page (uploaded to SN media server)

## Setup

### 1. Get a Stacker News API key

1. Log into [Stacker News](https://stacker.news/)
2. Go to your **Settings** → scroll to **API Keys**
3. Request API access (post in `~meta` requesting an API key for posting links)
4. Once approved, generate an API key

### 2. Configure GitHub Secrets

Add your API key as a repository secret:

| Secret | Value |
|--------|-------|
| `SN_API_KEY` | Your Stacker News API key |

**Via GitHub UI:** `Settings → Secrets and variables → Actions → New repository secret`

**Via CLI (requires `gh`):**
```bash
gh secret set SN_API_KEY < your-api-key-file
```

> **Note:** The ~Design territory has a posting fee. Ensure your SN account has sufficient CC balance (or attached wallet with sats) to cover 4 link posts per day. You can check the current fee by visiting the `~design` territory on Stacker News.

### 3. Enable GitHub Actions

The workflow runs automatically Mon-Fri at 1am UTC with a random 0-120 minute delay.

You can also trigger it manually via the **Actions** tab → **Post Sidebar Links** → **Run workflow**.

## How it works

1. Scrapes the [sidebar.io](https://sidebar.io/) homepage for today's 5 design links
2. Selects the first 4 (skips URLs already on Stacker News via the `dupes` API query)
3. For each link:
   - Takes a full-page screenshot using Playwright
   - Uploads the screenshot to Stacker News' S3-compatible media server
   - Creates a link post in `~design` with title, description, category hashtags, and screenshot
4. Posts are spaced 5-20 minutes apart to avoid rate limits

## Files

- `src/index.js` — Main bot script
- `.github/workflows/post-sidebar.yml` — GitHub Actions workflow
- `.env` — Local configuration (ignored by git)
