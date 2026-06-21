'use strict';

const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const JOBS_FILE = 'jobs.json';
const MAX_JOBS = 500;
const UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';

function loadExisting() {
  try {
    if (fs.existsSync(JOBS_FILE)) return JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  } catch {}
  return [];
}

async function classifySector(title, company = '', description = '') {
  if (!GEMINI_KEY) return 'Private';
  try {
    const genAI = new GoogleGenerativeAI(GEMINI_KEY);
    const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    const prompt = 'You are classifying a Pakistani job posting. Reply with exactly one word only: Government, Private, or NGO.\n' +
      `Title: ${title}\nCompany: ${(company || '').slice(0, 100)}\nDescription: ${(description || '').slice(0, 250)}`;
    const result = await model.generateContent(prompt);
    const text = (result.response.text() || '').trim();
    return ['Government', 'Private', 'NGO'].includes(text) ? text : 'Private';
  } catch (e) {
    console.warn('Gemini error:', e.message);
    return 'Private';
  }
}
