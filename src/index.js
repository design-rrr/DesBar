import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import * as cheerio from 'cheerio';
import { chromium } from 'playwright';
import { getPublicKey, finalizeEvent, nip19 } from 'nostr-tools';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SIDEBAR_HOMEPAGE = 'https://sidebar.io/';
const SN_BASE = 'https://stacker.news';
const SN_GRAPHQL = `${SN_BASE}/api/graphql/`;
const SN_MEDIA = 'https://m.stacker.news';
const SUB_NAME = 'Design';


const cookieStore = new Map();

function setCookies(cookieStrings) {
  for (const cookieStr of cookieStrings) {
    const [nameValue] = cookieStr.split(';');
    const eqIdx = nameValue.indexOf('=');
    if (eqIdx === -1) continue;
    const name = nameValue.slice(0, eqIdx).trim();
    const value = nameValue.slice(eqIdx + 1).trim();
    cookieStore.set(name, value);
  }
}

function getCookieHeader() {
  return Array.from(cookieStore.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function loadEnv() {
  const envPath = join(__dirname, '..', '.env');
  try {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  } catch { }
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function getPrivateKeyBytes(nostrSecret) {
  if (nostrSecret.startsWith('nsec1')) {
    const { data } = nip19.decode(nostrSecret);
    return new Uint8Array(data);
  }
  const hex = nostrSecret.startsWith('0x') ? nostrSecret.slice(2) : nostrSecret;
  return new Uint8Array(Buffer.from(hex, 'hex'));
}

async function nostrLogin() {
  const secret = process.env.NOSTR_SECRET;
  if (!secret) throw new Error('NOSTR_SECRET not set');

  const sk = getPrivateKeyBytes(secret);
  const pubkey = getPublicKey(sk);

  console.log('Requesting auth challenge...');
  const authRes = await fetch(SN_GRAPHQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `mutation createAuth { createAuth { k1 } }`,
    }),
  });
  const authJson = await authRes.json();
  if (authJson.errors) throw new Error(`createAuth error: ${JSON.stringify(authJson.errors)}`);
  const k1 = authJson.data.createAuth.k1;

  console.log('Creating signed Nostr event...');
  const signedEvent = finalizeEvent({
    kind: 27235,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['challenge', k1],
      ['u', SN_BASE],
      ['method', 'GET'],
    ],
    content: 'Stacker News Authentication',
  }, sk);

  console.log('Getting CSRF token...');
  const csrfRes = await fetch(`${SN_BASE}/api/auth/csrf`);
  setCookies(csrfRes.headers.getSetCookie());
  const csrfJson = await csrfRes.json();
  const csrfToken = csrfJson.csrfToken;

  console.log('Authenticating with Nostr...');
  const loginRes = await fetch(`${SN_BASE}/api/auth/callback/nostr`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: getCookieHeader(),
    },
    body: new URLSearchParams({
      csrfToken,
      event: JSON.stringify(signedEvent),
      callbackUrl: SN_BASE,
      json: 'true',
    }),
    redirect: 'manual',
  });

  setCookies(loginRes.headers.getSetCookie());

  if (!loginRes.ok) {
    const text = await loginRes.text();
    throw new Error(`Login failed (${loginRes.status}): ${text}`);
  }

  const loginJson = await loginRes.json();
  if (!loginJson.url) {
    throw new Error(`Login failed: ${JSON.stringify(loginJson)}`);
  }

  console.log(`Authenticated as ${pubkey}`);
  return pubkey;
}

function scrapePosts($, root) {
  const posts = [];

  root.find('.post-cell').each((_, el) => {
    const $el = $(el);
    const title = $el.find('.post-title a').text().trim();
    if (!title) return;

    const outUrl = $el.find('.post-title a').attr('href') || '';
    const urlMatch = outUrl.match(/[?&]url=([^&]+)/);
    let url = urlMatch ? decodeURIComponent(urlMatch[1]) : outUrl;

    try {
      const parsed = new URL(url);
      parsed.searchParams.delete('ref');
      url = parsed.toString();
    } catch { }

    const description = stripHtml($el.find('.post-body').html() || '');

    const categories = [];
    $el.find('.category-cell').each((__, catEl) => {
      const name = $(catEl).text().trim();
      if (name) categories.push(name);
    });

    posts.push({ title, url, description, categories });
  });

  return posts;
}

async function fetchSidebarPosts() {
  const res = await fetch(SIDEBAR_HOMEPAGE);
  const html = await res.text();
  const $ = cheerio.load(html);

  const daySections = $('.day');
  if (daySections.length === 0) {
    throw new Error('No day sections found on sidebar.io');
  }

  return scrapePosts($, daySections.eq(0));
}

async function fetchArchivesPosts() {
  const res = await fetch(`${SIDEBAR_HOMEPAGE}archives`);
  const html = await res.text();
  const $ = cheerio.load(html);

  return scrapePosts($, $('body'));
}

function stripHtml(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatDescription(description, categories) {
  const hashtags = categories.map(c => `#${c.replace(/\s+/g, '')}`).join(' ');
  return `${description}\n\n- - -\n\n${hashtags}`;
}

async function snApiCall(query, variables) {
  const res = await fetch(SN_GRAPHQL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: getCookieHeader(),
    },
    body: JSON.stringify({ query, variables }),
  });

  setCookies(res.headers.getSetCookie());

  const json = await res.json();
  if (json.errors) {
    throw new Error(`SN API error: ${JSON.stringify(json.errors)}`);
  }
  return json.data;
}

async function isAlreadyPosted(url) {
  try {
    const data = await snApiCall(`
      query dupes($url: String!) {
        dupes(url: $url) { id }
      }
    `, { url });
    return data.dupes && data.dupes.length > 0;
  } catch {
    return false;
  }
}

async function getSignedPost(type, size, width, height) {
  const data = await snApiCall(`
    mutation getSignedPOST($type: String!, $size: Int!, $width: Int!, $height: Int!) {
      getSignedPOST(type: $type, size: $size, width: $width, height: $height) {
        url
        fields
      }
    }
  `, { type, size, width, height });
  return data.getSignedPOST;
}

async function uploadToS3(signedPost, imageBuffer, type) {
  const { url, fields } = signedPost;

  const formData = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    formData.append(key, value);
  }
  formData.append('Content-Type', type);
  formData.append('Cache-Control', 'max-age=31536000');
  formData.append('acl', 'public-read');
  formData.append('file', new Blob([imageBuffer], { type }), 'screenshot.png');

  const res = await fetch(url, { method: 'POST', body: formData });
  if (!res.ok) {
    throw new Error(`S3 upload failed: ${res.status} ${await res.text()}`);
  }

  const key = fields.key;
  return `${SN_MEDIA}/${key}`;
}

async function takeScreenshot(url) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await delay(2000);
    const buffer = await page.screenshot({ type: 'png', fullPage: false });
    const { width, height } = page.viewportSize();
    return { buffer, width, height, type: 'image/png' };
  } finally {
    await browser.close();
  }
}

async function postLink(url, title, text) {
  const data = await snApiCall(`
    mutation upsertLink($subNames: [String!]!, $title: String!, $url: String!, $text: String) {
      upsertLink(subNames: $subNames, title: $title, url: $url, text: $text) {
        id
        payInState
        payerPrivates {
          result {
            ... on Item { id }
          }
          payInBolt11 { bolt11 msatsRequested }
        }
      }
    }
  `, { url, title, text, subNames: [SUB_NAME] });

  const payIn = data.upsertLink;
  if (payIn.payInState === 'PAID') {
    const itemId = payIn.payerPrivates?.result?.id;
    if (itemId) return itemId;
  }
  if (payIn.payerPrivates?.payInBolt11) {
    const { msatsRequested, bolt11 } = payIn.payerPrivates.payInBolt11;
    throw new Error(`Post requires ${Number(msatsRequested) / 1000} sats payment - add CC balance or fund your SN wallet`);
  }
  throw new Error(`Failed to create post: ${JSON.stringify(data)}`);
}

async function postItem(item) {
  console.log(`\n  Posting: ${item.title}`);
  console.log(`  URL: ${item.url}`);

  let imageUrl = null;
  try {
    console.log('  Taking screenshot...');
    const { buffer, width, height, type } = await takeScreenshot(item.url);
    const size = buffer.length;

    console.log(`  Screenshot: ${width}x${height}, ${(size / 1024).toFixed(1)}KB`);

    console.log('  Getting signed upload URL...');
    const signedPost = await getSignedPost(type, size, width, height);

    console.log('  Uploading to SN media server...');
    imageUrl = await uploadToS3(signedPost, buffer, type);
    console.log(`  Image URL: ${imageUrl}`);
  } catch (err) {
    console.log(`  Screenshot failed (will post without image): ${err.message}`);
  }

  const description = formatDescription(item.description, item.categories);
  const text = imageUrl ? `![](${imageUrl})\n\n${description}` : description;

  console.log('  Creating Stacker News post...');
  const postId = await postLink(item.url, item.title, text);
  console.log(`  Posted! Item ID: https://stacker.news/items/${postId}`);

  return postId;
}

async function main() {
  loadEnv();

  await nostrLogin();

  let posts = [];

  console.log('Fetching sidebar.io posts...');
  try {
    posts = await fetchSidebarPosts();
    console.log(`Found ${posts.length} post(s) on homepage`);
  } catch (err) {
    console.log(`Homepage fetch failed: ${err.message}`);
  }

  if (posts.length === 0) {
    console.log('Homepage empty, trying archives...');
    try {
      posts = await fetchArchivesPosts();
      console.log(`Found ${posts.length} post(s) in archives`);
    } catch (err) {
      console.log(`Archives fetch failed: ${err.message}`);
    }
  }

  if (posts.length === 0) {
    console.log('No posts found. Exiting.');
    return;
  }

  for (const item of posts) {
    console.log(`\nChecking: ${item.title}`);
    try {
      if (await isAlreadyPosted(item.url)) {
        console.log('  Already on Stacker News, skipping.');
        continue;
      }
    } catch (err) {
      console.log(`  Dupes check failed (will proceed anyway): ${err.message}`);
    }

    try {
      await postItem(item);
      console.log('\nDone. Posted 1 item.');
      return;
    } catch (err) {
      console.error(`  Failed to post "${item.title}": ${err.message}`);
    }
  }

  console.log('\nNo unposted items found. Nothing to do.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
