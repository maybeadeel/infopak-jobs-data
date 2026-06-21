'use strict';

const fs = require('fs');
const https = require('https');
const http = require('http');

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const JOBS_FILE = 'jobs.json';
const MAX_JOBS = 500;
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

// { url, source, stripSuffix } — source overrides auto-detection
const RSS_FEEDS = [
  // Site-specific feeds (most accurate source attribution + clean job titles)
  { url: 'https://news.google.com/rss/search?q=site:pakistanjobsbank.com&hl=en-PK&gl=PK&ceid=PK:en', source: 'pakistanjobsbank', strip: ' - Pakistan Jobs Bank' },
  { url: 'https://news.google.com/rss/search?q=site:getpakjob.com&hl=en-PK&gl=PK&ceid=PK:en', source: 'getpakjob', strip: ' - GetPakJob' },
  { url: 'https://news.google.com/rss/search?q=site:pakngos.com.pk&hl=en-PK&gl=PK&ceid=PK:en', source: 'pakngos', strip: ' - PakNGOs' },
  // General Pakistan jobs RSS
  { url: 'https://news.google.com/rss/search?q=jobs+pakistan+vacancy+apply&hl=en-PK&gl=PK&ceid=PK:en' },
  { url: 'https://news.google.com/rss/search?q=government+jobs+pakistan+2026+advertisement&hl=en-PK&gl=PK&ceid=PK:en' },
  { url: 'https://news.google.com/rss/search?q=ngo+jobs+pakistan+apply+now&hl=en-PK&gl=PK&ceid=PK:en' },
  { url: 'https://news.google.com/rss/search?q=private+jobs+pakistan+karachi+lahore+2026&hl=en-PK&gl=PK&ceid=PK:en' },
  { url: 'https://www.jobsalert.pk/feed/' },
];

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

function httpGet(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('Too many redirects'));
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/rss+xml,application/xml,text/xml,*/*',
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


function classifySector(title, company, description) {
  return inferSector(`${title} ${company || ''} ${description || ''}`);
}

// Regex-based RSS parser — avoids cheerio <link> bug
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
  let t = title.replace(/&amp;/g,'&').replace(/&#39;/g,"'").replace(/&quot;/g,'"').trim();
  if (strip && t.endsWith(strip)) t = t.slice(0, -strip.length).trim();
  // Also remove trailing " - SiteName" pattern generically
  t = t.replace(/\s+[-–]\s+(Pakistan Jobs Bank|GetPakJob|PakNGOs|JobsAlert)$/i, '').trim();
  return t;
}

function buildDescription(title, rawDesc, source) {
  // Google News descriptions for job sites are usually just title repeated — skip them
  const desc = rawDesc.replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
  const titleClean = title.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,30);
  const descClean = desc.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,30);
  if (!desc || desc.length < 20 || descClean.startsWith(titleClean)) {
    // Generate a helpful description from title keywords
    const year = new Date().getFullYear();
    return `${title}. Apply online for this position in Pakistan. Check eligibility, qualifications and last date on the official website.`;
  }
  return desc.slice(0, 400);
}

async function scrapeRssFeeds(existingIds) {
  const jobs = [];
  for (const feed of RSS_FEEDS) {
    const feedUrl = typeof feed === 'string' ? feed : feed.url;
    const feedSource = typeof feed === 'object' ? feed.source : null;
    const feedStrip = typeof feed === 'object' ? feed.strip : null;
    try {
      const xml = await httpGet(feedUrl);
      const items = extractRssItems(xml);
      console.log(`RSS ${feedUrl.slice(0, 65)}: ${items.length} items`);
      for (const item of items.slice(0, 30)) {
        const slug = Buffer.from(item.link)
          .toString('base64')
          .replace(/[^a-zA-Z0-9]/g, '')
          .slice(0, 80);
        const id = `rss_${slug}`;
        if (existingIds.has(id)) continue;
        const title = cleanTitle(item.title, feedStrip);
        if (title.length < 5) continue;
        const description = buildDescription(title, item.description, feedSource);
        const sector = classifySector(title, item.source, description);
        jobs.push({
          id,
          title,
          link: item.link,
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

  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days
  const seen = new Set();
  const merged = [...newJobs, ...existing].filter(j => {
    if (!j || !j.id) return false;
    if (seen.has(j.id)) return false;
    // Remove jobs older than 30 days
    const t = new Date(j.createdAt || j.pubDate || 0).getTime();
    if (Number.isFinite(t) && t < cutoff) return false;
    seen.add(j.id);
    return true;
  }).slice(0, MAX_JOBS);

  fs.writeFileSync(JOBS_FILE, JSON.stringify(merged, null, 2));
  console.log(`Saved ${merged.length} jobs to ${JOBS_FILE} (30-day window)`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
