import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import { getPublicKey, finalizeEvent, nip19, SimplePool } from 'nostr-tools';
import { TwitterApi } from 'twitter-api-v2';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SIDEBAR_HOMEPAGE = 'https://sidebar.io/';
const SIDEBAR_GRAPHQL = 'https://sidebar.io/graphql';
const SN_BASE = 'https://stacker.news';
const SN_GRAPHQL = `${SN_BASE}/api/graphql/`;
const SN_MEDIA = 'https://m.stacker.news';
const SUB_NAME = 'Design';

const BLOSSOM_SERVER = process.env.BLOSSOM_SERVER || 'https://cdn.hzrd149.com';
const NOSTR_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
  'wss://relay.nostr.band',
];

const postedInRun = new Set();

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hostname = u.hostname.replace(/^www\./, '').toLowerCase();
    u.pathname = u.pathname.replace(/\/$/, '') || '/';
    u.hash = '';
    const keep = [];
    for (const [k, v] of u.searchParams) {
      if (['ref', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'si', 'sk', 'source'].includes(k)) continue;
      keep.push(`${k}=${v}`);
    }
    keep.sort();
    u.search = keep.length ? '?' + keep.join('&') : '';
    return u.toString();
  } catch {
    return url;
  }
}


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

function extractCsrfFromCookies() {
  for (const [name, value] of cookieStore) {
    if (name.includes('csrf-token')) {
      const token = value.split('%7C')[0].split('|')[0];
      if (token) return token;
    }
  }
  return null;
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

async function getCsrfTokenWithBrowser() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    await page.goto(`${SN_BASE}/api/auth/csrf`, {
      waitUntil: 'networkidle',
      timeout: 30000,
    });
    await delay(1000);

    const cookies = await context.cookies();
    for (const cookie of cookies) {
      cookieStore.set(cookie.name, cookie.value);
    }

    const token = extractCsrfFromCookies();
    if (token) return token;

    const body = await page.evaluate(() => document.body.innerText);
    try {
      const json = JSON.parse(body);
      if (json.csrfToken) return json.csrfToken;
    } catch {}

    const html = await page.content();
    const match = html.match(/"csrfToken":"([^"]+)"/);
    if (match) return match[1];

    return null;
  } finally {
    await browser.close();
  }
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
  if (!authRes.ok) {
    const text = await authRes.text();
    throw new Error(`createAuth returned ${authRes.status}: ${text}`);
  }
  const authBody = await authRes.text();
  if (!authBody) throw new Error('createAuth returned empty body');
  const authJson = JSON.parse(authBody);
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
  let csrfToken = null;

  // Try simple fetch first (works locally, often WAF-blocked from GH Actions)
  for (let attempt = 0; attempt < 3; attempt++) {
    const csrfRes = await fetch(`${SN_BASE}/api/auth/csrf`);
    setCookies(csrfRes.headers.getSetCookie());
    csrfToken = extractCsrfFromCookies();
    if (csrfToken) break;
    if (attempt < 2) {
      const wait = (attempt + 1) * 2000;
      console.log(`CSRF attempt ${attempt + 1} (${csrfRes.status}), retrying in ${wait}ms...`);
      await delay(wait);
    }
  }

  if (!csrfToken) {
    console.log('Fetch failed, trying headless browser...');
    csrfToken = await getCsrfTokenWithBrowser();
  }

  if (!csrfToken) throw new Error('Could not obtain CSRF token');

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

  const loginBody = await loginRes.text();
  if (!loginBody) throw new Error(`Login returned empty body (status ${loginRes.status})`);
  const loginJson = JSON.parse(loginBody);
  if (!loginJson.url) {
    throw new Error(`Login failed: ${JSON.stringify(loginJson)}`);
  }

  console.log(`Authenticated as ${pubkey}`);
  return { pubkey, sk };
}

async function fetchSidebarPosts() {
  const res = await fetch(SIDEBAR_GRAPHQL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query { posts { results { _id title url body categories { name } } } }`,
    }),
  });

  const json = await res.json();
  const results = json.data?.posts?.results;
  if (!results || !results.length) throw new Error('No posts returned from sidebar.io GraphQL');

  return results.map(p => ({
    title: p.title,
    url: p.url,
    description: p.body || '',
    categories: (p.categories || []).map(c => c.name).filter(Boolean),
  }));
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
  const normalUrl = normalizeUrl(url);
  try {
    const data = await snApiCall(`
      query dupes($url: String!) {
        dupes(url: $url) { id }
      }
    `, { url: normalUrl });
    const found = data.dupes && data.dupes.length;
    if (found) console.log(`    → ${found} dupe(s) found on SN for: ${normalUrl}`);
    return found > 0;
  } catch (err) {
    console.log(`    → dupe check errored: ${err.message}`);
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

async function sha256(buffer) {
  const hash = await crypto.subtle.digest('SHA-256', buffer);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function base64url(json) {
  return Buffer.from(JSON.stringify(json)).toString('base64url');
}

async function uploadToBlossom(buffer, mimeType, sk) {
  const hash = await sha256(buffer);
  const expiration = Math.floor(Date.now() / 1000) + 300;

  const event = finalizeEvent({
    kind: 24242,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['t', 'upload'],
      ['expiration', String(expiration)],
      ['x', hash],
      ['m', mimeType],
      ['size', String(buffer.length)],
    ],
    content: 'Upload screenshot for sidebar post',
  }, sk);

  const res = await fetch(`${BLOSSOM_SERVER}/upload`, {
    method: 'PUT',
    headers: {
      'Authorization': `Nostr ${base64url(event)}`,
      'Content-Type': mimeType,
      'Content-Length': String(buffer.length),
      'X-SHA-256': hash,
    },
    body: buffer,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Blossom upload failed (${res.status}): ${text}`);
  }

  const data = await res.json().catch(() => ({}));
  return data.url || `${BLOSSOM_SERVER}/${hash}.png`;
}

async function publishNostrNote(content, sk) {
  const event = finalizeEvent({
    kind: 1,
    created_at: Math.floor(Date.now() / 1000),
    tags: [],
    content,
  }, sk);

  const pool = new SimplePool();
  const pubs = pool.publish(NOSTR_RELAYS, event);
  await Promise.allSettled(pubs);
  pool.close(NOSTR_RELAYS);

  console.log(`  Published Nostr note: ${event.id}`);
  return event.id;
}

async function postToTwitter(text, imageBuffer) {
  const TWITTER_CREDENTIALS = {
    appKey: process.env.TWITTER_API_KEY,
    appSecret: process.env.TWITTER_API_SECRET,
    accessToken: process.env.TWITTER_ACCESS_TOKEN,
    accessSecret: process.env.TWITTER_ACCESS_SECRET,
  };
  if (!TWITTER_CREDENTIALS.appKey) {
    console.log('  Twitter credentials not configured, skipping.');
    return;
  }

  const client = new TwitterApi(TWITTER_CREDENTIALS);
  let mediaId;
  if (imageBuffer) {
    mediaId = await client.v1.uploadMedia(imageBuffer, { mimeType: 'image/png' });
  }
  await client.v2.tweet({
    text: text.slice(0, 4000),
    media: mediaId ? { media_ids: [mediaId] } : undefined,
  });
  console.log('  Posted to Twitter/X');
}

async function takeScreenshot(url) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
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

async function isLinkAlive(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(10000) });
    if (!res.ok) {
      console.log(`  Link returned ${res.status}, skipping.`);
      return false;
    }
    return true;
  } catch (err) {
    console.log(`  Link check failed (${err.message}), proceeding anyway.`);
    return true;
  }
}

async function postItem(item, sk) {
  console.log(`\n  Posting: ${item.title}`);
  console.log(`  URL: ${item.url}`);

  if (!(await isLinkAlive(item.url))) {
    return null;
  }

  let imageBuffer, imageType, width, height;
  try {
    console.log('  Taking screenshot...');
    const shot = await takeScreenshot(item.url);
    imageBuffer = shot.buffer;
    imageType = shot.type;
    width = shot.width;
    height = shot.height;

    console.log(`  Screenshot: ${width}x${height}, ${(imageBuffer.length / 1024).toFixed(1)}KB`);
  } catch (err) {
    console.log(`  Screenshot failed (will post without image): ${err.message}`);
  }

  let blossomUrl = null;
  if (imageBuffer) {
    try {
      console.log('  Uploading to Blossom...');
      blossomUrl = await uploadToBlossom(imageBuffer, imageType, sk);
      console.log(`  Blossom URL: ${blossomUrl}`);
    } catch (err) {
      console.log(`  Blossom upload failed: ${err.message}`);
    }
  }

  let snImageUrl = null;
  if (imageBuffer) {
    try {
      console.log('  Getting signed upload URL...');
      const signedPost = await getSignedPost(imageType, imageBuffer.length, width, height);

      console.log('  Uploading to SN media server...');
      snImageUrl = await uploadToS3(signedPost, imageBuffer, imageType);
      console.log(`  SN image URL: ${snImageUrl}`);
    } catch (err) {
      console.log(`  SN media upload failed (will post without image): ${err.message}`);
    }
  }

  const description = formatDescription(item.description, item.categories);
  const snText = snImageUrl ? `![](${snImageUrl})\n\n${description}` : description;

  const normalUrl = normalizeUrl(item.url);

  console.log('  Checking dupe on SN one more time...');
  if (await isAlreadyPosted(normalUrl)) {
    console.log('  Already on Stacker News (re-checked), skipping.');
    return null;
  }

  console.log('  Creating Stacker News post...');
  const postId = await postLink(normalUrl, item.title, snText);
  const snUrl = `https://stacker.news/items/${postId}/r/deSign_r`;
  console.log(`  Posted! ${snUrl}`);

  const hashtags = item.categories.map(c => `#${c.replace(/\s+/g, '')}`).join(' ');
  const noteContent = `${item.title}\n\n${blossomUrl ? `${blossomUrl}\n\n` : ''}${item.description}\n\n${snUrl}\n\n${hashtags}`;
  try {
    console.log('  Publishing Nostr note...');
    await publishNostrNote(noteContent, sk);
  } catch (err) {
    console.log(`  Nostr publish failed: ${err.message}`);
  }

  try {
    console.log('  Posting to Twitter/X...');
    await postToTwitter(noteContent, imageBuffer);
  } catch (err) {
    console.log(`  Twitter post failed: ${err.message}`);
  }

  return postId;
}

async function runDry(posts) {
  console.log('\n========================================');
  console.log('  DRY RUN — no posts will be created');
  console.log('========================================\n');

  for (const item of posts) {
    console.log(`  Title:       ${item.title}`);
    console.log(`  URL:         ${item.url}`);
    console.log(`  Description: ${item.description.slice(0, 120)}${item.description.length > 120 ? '...' : ''}`);
    console.log(`  Categories:  ${item.categories.join(', ') || '(none)'}`);

    const hashtags = item.categories.map(c => `#${c.replace(/\s+/g, '')}`).join(' ');
    const text = `![](${SN_MEDIA}/{screenshot-id})\n\n${item.description}\n\n- - -\n\n${hashtags}`;
    console.log(`\n  Post body preview:\n${text}\n`);
    console.log('  ---');
  }

  console.log(`\nTotal: ${posts.length} post(s) ready to publish.\n`);
}

async function tryPostOne(posts, sk) {
  for (const item of posts) {
    const normalUrl = normalizeUrl(item.url);
    console.log(`\nChecking: ${item.title}`);

    if (postedInRun.has(normalUrl)) {
      console.log('  Already posted in this run, skipping.');
      continue;
    }

    try {
      if (await isAlreadyPosted(item.url)) {
        console.log('  Already on Stacker News, skipping.');
        postedInRun.add(normalUrl);
        continue;
      }
    } catch (err) {
      console.log(`  Dupes check failed (will proceed anyway): ${err.message}`);
    }

    try {
      const result = await postItem(item, sk);
      if (result === null) continue;
      postedInRun.add(normalUrl);
      console.log('\nDone. Posted 1 item.');
      return true;
    } catch (err) {
      console.error(`  Failed to post "${item.title}": ${err.message}`);
    }
  }
  return false;
}

async function main() {
  loadEnv();

  const isDryRun = process.env.DRY_RUN === 'true';

  console.log('Fetching sidebar.io posts...');
  let posts;
  try {
    posts = await fetchSidebarPosts();
    console.log(`Found ${posts.length} post(s)`);
  } catch (err) {
    console.log(`Sidebar fetch failed: ${err.message}`);
    posts = [];
  }

  if (isDryRun) {
    if (posts.length === 0) {
      console.log('No posts found. Exiting.');
    } else {
      await runDry(posts);
    }
    return;
  }

  const { sk } = await nostrLogin();

  if (posts.length > 0) {
    if (await tryPostOne(posts, sk)) return;
  }

  console.log('\nNo unposted items found. Nothing to do.');
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
