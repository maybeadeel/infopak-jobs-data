'use strict';

const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const JOBS_FILE = 'jobs.json';
const MAX_JOBS = 500;
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

const RSS_FEEDS = [
  'https://www.paperpk.com/jobs/feed/',
  'https://www.jobsalert.pk/feed/',
  'https://feeds.feedburner.com/PakistanJobsBank',
  'https://news.google.com/rss/search?q=jobs+pakistan+vacancy+apply&hl=en-PK&gl=PK&ceid=PK:en',
  'https://news.google.com/rss/search?q=government+jobs+pakistan+2025&hl=en-PK&gl=PK&ceid=PK:en',
  'https://news.google.com/rss/search?q=ngo+jobs+pakistan+apply+now&hl=en-PK&gl=PK&ceid=PK:en',
  'https://news.google.com/rss/search?q=private+jobs+pakistan+karachi+lahore&hl=en-PK&gl=PK&ceid=PK:en',
];

function loadExisting() {
  try {
    if (fs.existsSync(JOBS_FILE)) return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  } catch {}
  return [];
}

async function classifySector(title, company = '', description = '') {
  if (!GEMINI_KEY) return inferSector(title);
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = 'You are classifying a Pakistani job posting. Reply with exactly one word only: Government, Private, or NGO.\n' +
      `Title: ${title}\nCompany: ${(company || '').slice(0, 100)}\nDescription: ${(description || '').slice(0, 250)}`;
    const result = await model.generateContent(prompt);
    const text = (result.response.text() || '').trim();
    return ['Government', 'Private', 'NGO'].includes(text) ? text : inferSector(title);
  } catch (e) {
    console.warn('Gemini error:', e.message);
    return inferSector(title);
  }
}

function inferSector(text) {
  const t = (text || '').toLowerCase();
  if (/government|govt|federal|provincial|ministry|department|public sector|army|navy|air force|police|ppsc|fpsc|kppsc|bpsc|spsc|nts|ots|pts/.test(t)) return 'Government';
  if (/ngo|non.?profit|un |united nations|unicef|undp|world bank|oxfam|save the children|aga khan|edhi/.test(t)) return 'NGO';
  return 'Private';
}

async function scrapeRssFeeds(existingIds) {
  const jobs = [];
  for (const url of RSS_FEEDS) {
    try {
      const res = await axios.get(url, {
        headers: { 'User-Agent': UA, 'Accept': 'application/rss+xml,application/xml,text/xml,*/*' },
        timeout: 12000,
      });
      const $ = cheerio.load(res.data, { xmlMode: true });
      const items = $('item').toArray().slice(0, 30);
      console.log(`RSS ${url}: ${items.length} items`);
      for (const el of items) {
        const $el = $(el);
        const title = $el.find('title').text().replace(/<!\[CDATA\[|\]\]>/g, '').trim();
        const link = ($el.find('link').text().trim() || $el.find('guid').text().trim()).replace(/<!\[CDATA\[|\]\]>/g, '').trim();
        const description = $el.find('description').text().replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim().slice(0, 300);
        const company = $el.find('source, author, dc\\:creator').first().text().replace(/<!\[CDATA\[|\]\]>/g, '').trim();
        const pubDate = $el.find('pubDate').text().trim();
        if (!title || title.length < 5 || !link || link.length < 10) continue;
        const slug = Buffer.from(link).toString('base64').slice(0, 80).replace(/[^a-zA-Z0-9]/g, '');
        const id = `rss_${slug}`;
        if (existingIds.has(id)) continue;
        const sector = await classifySector(title, company, description);
        jobs.push({ id, title, link, company, description, sector, source: 'rss', pubDate, createdAt: new Date().toISOString() });
      }
    } catch (e) {
      console.warn(`RSS ${url}:`, e.message);
    }
  }
  return jobs;
}

async function scrapePakistanJobsBank(existingIds) {
  const jobs = [];
  for (const page of ['', '/government-jobs', '/private-sector-jobs', '/ngo-jobs']) {
    try {
      const res = await axios.get(`https://www.pakistanjobsbank.com${page}`, { headers: { 'User-Agent': UA }, timeout: 15000 });
      const $ = cheerio.load(res.data);
      for (const el of $('article, .post').toArray().slice(0, 20)) {
        const $el = $(el);
        const titleEl = $el.find('h2 a, h3 a, .entry-title a').first();
        const title = titleEl.text().trim();
        const link = titleEl.attr('href') || '';
        if (!title || link.length < 10) continue;
        const id = `pjb_${(link.split('/').filter(Boolean).pop() || Date.now().toString()).slice(0, 80)}`;
        if (existingIds.has(id)) continue;
        const company = $el.find('.cat-links, .post-categories').first().text().trim();
        const description = $el.find('.entry-summary p, .entry-content p').first().text().trim().slice(0, 300);
        const sector = await classifySector(title, company, description);
        jobs.push({ id, title, link, company, description, sector, source: 'pakistanjobsbank', createdAt: new Date().toISOString() });
      }
    } catch (e) { console.warn(`pjb${page}:`, e.message); }
  }
  return jobs;
}

async function scrapeGetPakJob(existingIds) {
  const jobs = [];
  for (const page of ['/', '/government-jobs', '/private-jobs', '/ngo-jobs']) {
    try {
      const res = await axios.get(`https://www.getpakjob.com${page}`, { headers: { 'User-Agent': UA }, timeout: 15000 });
      const $ = cheerio.load(res.data);
      for (const el of $('article, .job-listing, .post').toArray().slice(0, 20)) {
        const $el = $(el);
        const titleEl = $el.find('h2 a, h3 a, .job-title a, .entry-title a').first();
        const title = titleEl.text().trim();
        const link = titleEl.attr('href') || '';
        if (!title || link.length < 10) continue;
        const id = `gpj_${(link.split('/').filter(Boolean).pop() || Date.now().toString()).slice(0, 80)}`;
        if (existingIds.has(id)) continue;
        const company = $el.find('.company-name, .employer, .cat-links').first().text().trim();
        const location = $el.find('.location, .job-location').first().text().trim();
        const description = ($el.find('p').first().text().trim() + (location ? ` — ${location}` : '')).slice(0, 300);
        const sector = await classifySector(title, company, description);
        jobs.push({ id, title, link, company, description, sector, location, source: 'getpakjob', createdAt: new Date().toISOString() });
      }
    } catch (e) { console.warn(`gpj${page}:`, e.message); }
  }
  return jobs;
}

async function scrapePakNgos(existingIds) {
  const jobs = [];
  for (const page of ['/jobs/', '/jobs/page/2/']) {
    try {
      const res = await axios.get(`https://www.pakngos.com.pk${page}`, { headers: { 'User-Agent': UA }, timeout: 15000 });
      const $ = cheerio.load(res.data);
      for (const el of $('article, .job-listing, .post').toArray().slice(0, 20)) {
        const $el = $(el);
        const titleEl = $el.find('h2 a, h3 a, .entry-title a').first();
        const title = titleEl.text().trim();
        const link = titleEl.attr('href') || '';
        if (!title || link.length < 10) continue;
        const id = `ngos_${(link.split('/').filter(Boolean).pop() || Date.now().toString()).slice(0, 80)}`;
        if (existingIds.has(id)) continue;
        const company = $el.find('.company-name, .organization, .cat-links').first().text().trim();
        const description = $el.find('p').first().text().trim().slice(0, 300);
        jobs.push({ id, title, link, company, description, sector: 'NGO', source: 'pakngos', createdAt: new Date().toISOString() });
      }
    } catch (e) { console.warn(`pakngos${page}:`, e.message); }
  }
  return jobs;
}

async function main() {
  const existing = loadExisting();
  const existingIds = new Set(existing.map(j => j.id));
  console.log(`Existing: ${existing.length} jobs`);

  const [r1, r2, r3, r4] = await Promise.allSettled([
    scrapeRssFeeds(existingIds),
    scrapePakistanJobsBank(existingIds),
    scrapeGetPakJob(existingIds),
    scrapePakNgos(existingIds),
  ]);

  const newJobs = [
    ...(r1.status === 'fulfilled' ? r1.value : []),
    ...(r2.status === 'fulfilled' ? r2.value : []),
    ...(r3.status === 'fulfilled' ? r3.value : []),
    ...(r4.status === 'fulfilled' ? r4.value : []),
  ];
  console.log(`New jobs found: ${newJobs.length}`);

  const seen = new Set();
  const merged = [...newJobs, ...existing].filter(j => {
    if (seen.has(j.id)) return false;
    seen.add(j.id);
    return true;
  }).slice(0, MAX_JOBS);

  fs.writeFileSync(JOBS_FILE, JSON.stringify(merged, null, 2));
  console.log(`Saved ${merged.length} jobs to ${JOBS_FILE}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
