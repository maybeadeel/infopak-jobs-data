'use strict';

const fs = require('fs');
const https = require('https');
const http = require('http');

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const JOBS_FILE = 'jobs.json';
const MAX_JOBS = 500;
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const RSS_FEEDS = [
  'https://news.google.com/rss/search?q=jobs+pakistan+vacancy+apply&hl=en-PK&gl=PK&ceid=PK:en',
  'https://news.google.com/rss/search?q=government+jobs+pakistan+2025+advertisement&hl=en-PK&gl=PK&ceid=PK:en',
  'https://news.google.com/rss/search?q=ngo+jobs+pakistan+apply+now&hl=en-PK&gl=PK&ceid=PK:en',
  'https://news.google.com/rss/search?q=private+jobs+pakistan+karachi+lahore+2025&hl=en-PK&gl=PK&ceid=PK:en',
  'https://news.google.com/rss/search?q=rozee+mustakbil+jobs+pakistan&hl=en-PK&gl=PK&ceid=PK:en',
  'https://news.google.com/rss/search?q=pakistan+jobs+2025+latest+apply&hl=en-PK&gl=PK&ceid=PK:en',
  'https://www.jobsalert.pk/feed/',
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

function httpPost(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => resolve(data));
    });
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function classifySector(title, company, description) {
  if (!GEMINI_KEY) return inferSector(title + ' ' + description);
  try {
    const body = JSON.stringify({
      contents: [{ parts: [{ text:
        'You are classifying a Pakistani job posting. Reply with exactly one word only: Government, Private, or NGO.\n' +
        `Title: ${title}\nCompany: ${(company || '').slice(0, 100)}\nDescription: ${(description || '').slice(0, 250)}`
      }] }],
      generationConfig: { maxOutputTokens: 10 },
    });
    const raw = await httpPost(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEY}`,
      body,
    );
    const parsed = JSON.parse(raw);
    const text = (parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    return ['Government', 'Private', 'NGO'].includes(text) ? text : inferSector(title);
  } catch (e) {
    console.warn('Gemini error:', e.message);
    return inferSector(title + ' ' + description);
  }
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

async function scrapeRssFeeds(existingIds) {
  const jobs = [];
  for (const url of RSS_FEEDS) {
    try {
      const xml = await httpGet(url);
      const items = extractRssItems(xml);
      console.log(`RSS ${url.slice(0, 70)}: ${items.length} items`);
      for (const item of items.slice(0, 30)) {
        const slug = Buffer.from(item.link)
          .toString('base64')
          .replace(/[^a-zA-Z0-9]/g, '')
          .slice(0, 80);
        const id = `rss_${slug}`;
        if (existingIds.has(id)) continue;
        const sector = await classifySector(item.title, item.source, item.description);
        jobs.push({
          id,
          title: item.title,
          link: item.link,
          company: item.source,
          description: item.description.slice(0, 300),
          sector,
          source: 'rss',
          pubDate: item.pubDate,
          createdAt: new Date().toISOString(),
        });
      }
    } catch (e) {
      console.warn(`RSS error ${url.slice(0, 70)}:`, e.message);
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

  const seen = new Set();
  const merged = [...newJobs, ...existing].filter(j => {
    if (!j || !j.id) return false;
    if (seen.has(j.id)) return false;
    seen.add(j.id);
    return true;
  }).slice(0, MAX_JOBS);

  fs.writeFileSync(JOBS_FILE, JSON.stringify(merged, null, 2));
  console.log(`Saved ${merged.length} jobs to ${JOBS_FILE}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
