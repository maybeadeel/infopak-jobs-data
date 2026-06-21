'use strict';

const fs = require('fs');
const https = require('https');
const http = require('http');

const JOBS_FILE = 'jobs.json';
const MAX_JOBS = 500;
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const RSS_FEEDS = [
  // Site-specific Google News (job-focused results; links resolved to direct site URLs)
  { url: 'https://news.google.com/rss/search?q=site:pakistanjobsbank.com&hl=en-PK&gl=PK&ceid=PK:en', source: 'pakistanjobsbank', strip: ' - Pakistan Jobs Bank' },
  { url: 'https://news.google.com/rss/search?q=site:getpakjob.com&hl=en-PK&gl=PK&ceid=PK:en', source: 'getpakjob', strip: ' - GetPakJob' },
  { url: 'https://news.google.com/rss/search?q=site:pakngos.com.pk+jobs+apply&hl=en-PK&gl=PK&ceid=PK:en', source: 'pakngos', strip: ' - PakNGOs' },
  // PakNGOs direct WordPress RSS — gives direct site URLs (no Google redirect)
  { url: 'https://pakngos.com.pk/feed/', source: 'pakngos', jobsOnly: true },
  // General Pakistan jobs feeds
  { url: 'https://news.google.com/rss/search?q=government+jobs+pakistan+2026+advertisement&hl=en-PK&gl=PK&ceid=PK:en' },
  { url: 'https://news.google.com/rss/search?q=ngo+jobs+pakistan+apply+now&hl=en-PK&gl=PK&ceid=PK:en' },
  { url: 'https://news.google.com/rss/search?q=private+jobs+pakistan+karachi+lahore+2026&hl=en-PK&gl=PK&ceid=PK:en' },
  { url: 'https://www.jobsalert.pk/feed/' },
];

// Keywords that indicate a listing is a job / opportunity
const JOB_RE = /\b(job|jobs|vacancy|vacancies|position|career|hiring|recruitment|apply|officer|manager|coordinator|analyst|engineer|director|assistant|consultant|specialist|intern|staff|driver|teacher|trainer|worker|agent|technician|admin|supervisor|rfp|proposal|open call|expression of interest|eoi|required|needed)\b/i;

function loadExisting() {
  try {
    if (fs.existsSync(JOBS_FILE)) {
      const data = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
      return Array.isArray(data) ? data : [];
    }
  } catch {}
  return [];
}

function inferSector(text) {
  const t = (text || '').toLowerCase();
  if (/government|govt|federal|provincial|ministry|department|public sector|army|navy|air force|police|ppsc|fpsc|kppsc|bpsc|spsc|nts|ots|pts|sarkari/.test(t))
    return 'Government';
  if (/ngo|non.?profit|\bun\b|united nations|unicef|undp|world bank|oxfam|save the children|aga khan|edhi/.test(t))
    return 'NGO';
  return 'Private';
}

function classifySector(title, company, description) {
  return inferSector(`${title} ${company || ''} ${description || ''}`);
}

// Follow one redirect hop; returns next URL or null if not a redirect
function followOneRedirect(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': UA, Accept: '*/*' } }, (res) => {
      res.resume(); // discard body immediately
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const loc = res.headers.location;
        if (loc.startsWith('/')) {
          try {
            const u = new URL(url);
            resolve(`${u.protocol}//${u.host}${loc}`);
          } catch { resolve(loc); }
        } else {
          resolve(loc);
        }
      } else {
        resolve(null);
      }
    });
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// Resolve a Google News redirect URL to the original article URL
async function resolveGoogleUrl(originalUrl) {
  if (!originalUrl.includes('google.com')) return originalUrl;
  let url = originalUrl;
  for (let i = 0; i < 6; i++) {
    const next = await followOneRedirect(url);
    if (!next) break;
    url = next;
    // Stop once we've left Google's domain
    if (!url.includes('google.com') && !url.includes('consent.')) break;
  }
  return url;
}

// Run async tasks with bounded concurrency
async function runParallel(items, fn, concurrency = 8) {
  const results = new Array(items.length);
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

function httpGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'application/rss+xml,application/xml,text/xml,*/*',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(httpGet(res.headers.location, redirects + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.setTimeout(12000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// Regex-based RSS parser — avoids cheerio <link> tag parsing bug
function extractRssItems(xml) {
  const items = [];
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(xml)) !== null) {
    const block = m[1];
    const get = (tag) => {
      const r = new RegExp(
        `<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`, 'i',
      );
      const match = block.match(r);
      return match ? match[1].trim() : '';
    };
    const title = get('title');
    const link = get('link') || get('guid');
    const description = get('description').replace(/<[^>]+>/g, '').trim();
    const pubDate = get('pubDate');
    const source = get('source') || get('author') || get('dc:creator') || '';
    if (title && link && title.length >= 5 && link.length >= 10) {
      items.push({ title, link, description, pubDate, source });
    }
  }
  return items;
}

function cleanTitle(title, strip) {
  let t = title
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#8217;/g, "'")
    .replace(/&#8211;/g, '–')
    .trim();
  if (strip && t.endsWith(strip)) t = t.slice(0, -strip.length).trim();
  t = t.replace(/\s+[-–]\s+(Pakistan Jobs Bank|GetPakJob|PakNGOs|JobsAlert)$/i, '').trim();
  return t;
}

function buildDescription(title, rawDesc, source) {
  const desc = rawDesc.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
  const titleClean = title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
  const descClean = desc.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30);
  if (!desc || desc.length < 20 || descClean.startsWith(titleClean)) {
    return `${title}. Apply online for this position in Pakistan. Check eligibility, qualifications and last date on the official website.`;
  }
  return desc.slice(0, 400);
}

async function scrapeRssFeeds(existingIds) {
  const jobs = [];

  for (const feed of RSS_FEEDS) {
    const feedUrl = typeof feed === 'string' ? feed : feed.url;
    const feedSource = typeof feed === 'object' ? (feed.source || null) : null;
    const feedStrip = typeof feed === 'object' ? (feed.strip || null) : null;
    const jobsOnly = typeof feed === 'object' ? !!feed.jobsOnly : false;
    const isGoogleNews = feedUrl.includes('news.google.com');

    try {
      const xml = await httpGet(feedUrl);
      const rawItems = extractRssItems(xml);
      console.log(`RSS ${feedUrl.slice(0, 65)}: ${rawItems.length} items`);

      // Resolve Google News redirect links to direct article URLs (parallel)
      let resolvedLinks;
      if (isGoogleNews && rawItems.length > 0) {
        console.log(`  Resolving ${rawItems.length} links...`);
        resolvedLinks = await runParallel(rawItems, item => resolveGoogleUrl(item.link), 8);
        const resolved = resolvedLinks.filter(l => !l.includes('google.com')).length;
        console.log(`  Resolved ${resolved}/${rawItems.length} to direct URLs`);
      }

      for (let idx = 0; idx < rawItems.slice(0, 30).length; idx++) {
        const item = rawItems[idx];
        const directLink = resolvedLinks ? resolvedLinks[idx] : item.link;

        const title = cleanTitle(item.title, feedStrip);
        if (title.length < 5) continue;

        // For feeds that mix non-job content, filter by keywords
        if (jobsOnly && !JOB_RE.test(title) && !JOB_RE.test(item.description)) continue;

        const slug = Buffer.from(directLink || item.link)
          .toString('base64')
          .replace(/[^a-zA-Z0-9]/g, '')
          .slice(0, 80);
        const id = `rss_${slug}`;
        if (existingIds.has(id)) continue;

        const description = buildDescription(title, item.description, feedSource);
        const sector = classifySector(title, item.source, description);

        jobs.push({
          id,
          title,
          link: directLink || item.link,
          company: item.source || '',
          description,
          sector,
          source: feedSource || 'rss',
          pubDate: item.pubDate,
          createdAt: new Date().toISOString(),
        });
      }
    } catch (e) {
      console.warn(`RSS error ${feedUrl.slice(0, 65)}:`, e.message);
    }
  }

  return jobs;
}

async function main() {
  const existing = loadExisting();
  const existingIds = new Set(existing.map(j => j.id));
  console.log(`Existing: ${existing.length} jobs`);

  const newJobs = await scrapeRssFeeds(existingIds);
  console.log(`New jobs found: ${newJobs.length}`);

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const seen = new Set();
  const merged = [...newJobs, ...existing].filter(j => {
    if (!j || !j.id) return false;
    if (seen.has(j.id)) return false;
    const t = new Date(j.createdAt || j.pubDate || 0).getTime();
    if (Number.isFinite(t) && t < cutoff) return false;
    seen.add(j.id);
    return true;
  }).slice(0, MAX_JOBS);

  fs.writeFileSync(JOBS_FILE, JSON.stringify(merged, null, 2));
  console.log(`Saved ${merged.length} jobs to ${JOBS_FILE} (30-day window)`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
