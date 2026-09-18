import fs from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright";
import { google } from "googleapis";

const SOURCE_URL =
  "https://www.xiaohongshu.com/explore?channel_id=homefeed_recommend";
const TIME_ZONE = "Australia/Sydney";
const OUT_DIR = "out";

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured.`);
  return value;
}

const DETAILS_FOLDER_ID = requiredEnv("GOOGLE_DRIVE_DETAILS_FOLDER_ID");

function sydneyParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value ?? "";

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

function normalizeLikes(input) {
  if (!input) return null;

  const raw = String(input)
    .trim()
    .replace(/,/g, "")
    .replace(/\s+/g, "")
    .toLowerCase();

  if (!raw || raw === "赞" || raw === "like" || raw === "likes") return null;

  const match = raw.match(/([0-9]+(?:\.[0-9]+)?)(万|千|w|k|m)?/i);
  if (!match) return null;

  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;

  const suffix = match[2]?.toLowerCase();
  const multiplier =
    suffix === "万" || suffix === "w"
      ? 10000
      : suffix === "千" || suffix === "k"
        ? 1000
        : suffix === "m"
          ? 1000000
          : 1;

  return Math.round(value * multiplier);
}

function compact(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

async function closeLoginPopup(page) {
  const selectors = [
    'button[aria-label="关闭"]',
    '[role="dialog"] button:has-text("关闭")',
    '[class*="login"] [class*="close"]',
    '[class*="modal"] [class*="close"]',
  ];

  for (const selector of selectors) {
    try {
      const candidate = page.locator(selector).first();
      if (await candidate.isVisible({ timeout: 500 })) {
        await candidate.click({ timeout: 1000 });
        return;
      }
    } catch {
      // Best effort only.
    }
  }
}

async function extractCards(page) {
  return page.evaluate(() => {
    const getText = (root, selectors) => {
      for (const selector of selectors) {
        const el = root.querySelector(selector);
        const value = el?.textContent?.replace(/\s+/g, " ").trim();
        if (value) return value;
      }
      return "";
    };

    const getUrl = (root) => {
      const a =
        root.querySelector('a[href*="/explore/"]') ||
        root.querySelector('a[href*="/discovery/item/"]');
      if (!a) return "";

      try {
        return new URL(a.getAttribute("href"), location.origin).href;
      } catch {
        return a.href || "";
      }
    };

    let nodes = Array.from(
      document.querySelectorAll(
        "section.note-item, article.note-item, .note-item, [class*='note-item']"
      )
    );

    if (!nodes.length) {
      nodes = Array.from(
        document.querySelectorAll(
          'a[href*="/explore/"], a[href*="/discovery/item/"]'
        )
      )
        .map(
          (a) =>
            a.closest("section") ||
            a.closest("article") ||
            a.closest("[class*='note']") ||
            a.parentElement
        )
        .filter(Boolean);
    }

    const result = [];
    const seen = new Set();

    for (const node of nodes) {
      const url = getUrl(node);
      if (!url || seen.has(url)) continue;

      const title = getText(node, [
        ".title",
        "[class*='title']",
        "[class*='note-title']",
      ]);

      const author = getText(node, [
        ".author .name",
        ".author-wrapper .name",
        "[class*='author'] [class*='name']",
        "[class*='author']",
      ]);

      let likesText = getText(node, [
        ".like-wrapper .count",
        "[class*='like'] [class*='count']",
        "[class*='like']",
      ]);

      if (!likesText) {
        const pieces = (node.innerText || "")
          .split(/\n+/)
          .map((x) => x.trim())
          .filter(Boolean);

        likesText =
          [...pieces]
            .reverse()
            .find((x) =>
              /^[0-9]+(?:\.[0-9]+)?(?:万|千|w|k|m)?$/i.test(x)
            ) || "";
      }

      const hasVideo =
        Boolean(node.querySelector("video")) ||
        Boolean(node.querySelector("[class*='video']"));

      seen.add(url);
      result.push({
        title,
        author,
        likesText,
        url,
        format: hasVideo ? "video" : "image",
      });
    }

    return result;
  });
}

function buildMarkdown({ date, time, visibleLikeCards, cards }) {
  const lines = [
    "# XHS Explore Sample",
    "",
    "| field | value |",
    "| --- | --- |",
    `| date | ${date} |`,
    `| time | ${time} |`,
    `| timezone | ${TIME_ZONE} |`,
    `| source | ${SOURCE_URL} |`,
    `| visible_like_cards | ${visibleLikeCards} |`,
    "| caveat | personalized explore; visible 赞 only; not official ranking |",
    "",
    "## Top 5",
    "",
  ];

  cards.forEach((card, index) => {
    lines.push(
      `### ${index + 1}`,
      `- title: ${compact(card.title) || "(untitled)"}`,
      `- author: ${compact(card.author) || "(unknown)"}`,
      `- likes: ${card.likes}`,
      `- url: ${card.url}`,
      `- format: ${card.format || "unknown"}`,
      "- hypothesis: pending daily ChatGPT summary",
      ""
    );
  });

  return lines.join("\n");
}

function driveClient() {
  const raw = requiredEnv("GOOGLE_SERVICE_ACCOUNT_JSON");

  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON.");
  }

  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/drive"],
  });

  return google.drive({ version: "v3", auth });
}

function driveQuote(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function findOrCreateDateFolder(drive, date) {
  const q =
    `'${driveQuote(DETAILS_FOLDER_ID)}' in parents and ` +
    `name = '${driveQuote(date)}' and ` +
    "mimeType = 'application/vnd.google-apps.folder' and trashed = false";

  const found = await drive.files.list({
    q,
    fields: "files(id,name)",
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });

  if (found.data.files?.length) return found.data.files[0].id;

  const created = await drive.files.create({
    requestBody: {
      name: date,
      mimeType: "application/vnd.google-apps.folder",
      parents: [DETAILS_FOLDER_ID],
    },
    fields: "id,name",
    supportsAllDrives: true,
  });

  if (!created.data.id) {
    throw new Error("Google Drive did not return an id for the date folder.");
  }

  return created.data.id;
}

async function uploadMarkdown(markdown, fileName, date) {
  const drive = driveClient();
  const dateFolderId = await findOrCreateDateFolder(drive, date);

  const created = await drive.files.create({
    requestBody: {
      name: fileName,
      parents: [dateFolderId],
    },
    media: {
      mimeType: "text/markdown",
      body: Buffer.from(markdown, "utf8"),
    },
    fields: "id,name,webViewLink",
    supportsAllDrives: true,
  });

  if (!created.data.id) {
    throw new Error("Google Drive upload returned no file id.");
  }

  console.log(`Drive upload complete: ${created.data.name || fileName}`);
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  let page;

  try {
    const context = await browser.newContext({
      locale: "zh-CN",
      timezoneId: TIME_ZONE,
      viewport: { width: 1440, height: 1200 },
    });

    page = await context.newPage();

    await page.goto(SOURCE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    await page.waitForTimeout(5000);
    await closeLoginPopup(page);

    for (let i = 0; i < 4; i += 1) {
      await page.mouse.wheel(0, 1000);
      await page.waitForTimeout(1200);
    }

    const rawCards = await extractCards(page);

    const numericCards = rawCards
      .map((card) => ({ ...card, likes: normalizeLikes(card.likesText) }))
      .filter((card) => Number.isFinite(card.likes));

    const uniqueCards = Array.from(
      new Map(numericCards.map((card) => [card.url, card])).values()
    );

    const top5 = uniqueCards
      .sort((a, b) => b.likes - a.likes)
      .slice(0, 5);

    const p = sydneyParts();
    const date = `${p.year}-${p.month}-${p.day}`;
    const time = `${p.hour}:${p.minute}`;
    const fileName =
      `XHS-sample-${date}-${p.hour}-${p.minute}${p.second}-Sydney.md`;

    const markdown = buildMarkdown({
      date,
      time,
      visibleLikeCards: numericCards.length,
      cards: top5,
    });

    await fs.writeFile(path.join(OUT_DIR, fileName), markdown, "utf8");
    await page.screenshot({
      path: path.join(OUT_DIR, "debug.png"),
      fullPage: true,
    });
    await fs.writeFile(
      path.join(OUT_DIR, "debug.html"),
      await page.content(),
      "utf8"
    );

    console.log(`Candidate cards: ${rawCards.length}`);
    console.log(`Cards with numeric visible likes: ${numericCards.length}`);

    if (!top5.length) {
      throw new Error(
        "No cards with numeric visible likes were extracted. Inspect the debug artifact."
      );
    }

    await uploadMarkdown(markdown, fileName, date);
  } finally {
    if (page) {
      try {
        await page.screenshot({
          path: path.join(OUT_DIR, "final-state.png"),
          fullPage: true,
        });
      } catch {
        // Ignore teardown screenshot errors.
      }
    }

    await browser.close();
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
