# XHS Trend Scout

Public GitHub Actions test for sampling the Xiaohongshu Explore feed.

## Workflow

Every 2 hours:

1. Start Chromium with Playwright.
2. Open `https://www.xiaohongshu.com/explore?channel_id=homefeed_recommend`.
3. Read visible Explore cards.
4. Normalize displayed like counts and select the top 5.
5. Save a Markdown sample using Australia/Sydney time.
6. Upload it to Google Drive:

```text
XHS-24hrs-Explore-Hypotheses/
├── details/
│   └── YYYY-MM-DD/
│       └── XHS-sample-YYYY-MM-DD-HH-MMSS-Sydney.md
└── summary/
    └── XHS-sample-YYYY-MM-DD-summary.md
```

The GitHub Actions run also stores the generated Markdown, a screenshot, and page HTML as an artifact for debugging.

## Required repository secret

`GOOGLE_SERVICE_ACCOUNT_JSON`

`GOOGLE_DRIVE_DETAILS_FOLDER_ID`

The service-account email in the JSON must have write access to the shared Google Drive folders. The folder ID itself is injected only through GitHub Actions Secrets and is not stored in this public repository.

Do not commit the JSON credential to this repository.

## Manual test

Open **Actions → XHS Trend Scout → Run workflow**.

The result represents the visible feed returned to this browser session, not an official Xiaohongshu platform-wide ranking.
