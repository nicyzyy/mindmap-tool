const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO = process.env.GITHUB_REPO || 'nicyzyy/mindmap-tool';
const DATA_FILE = 'data/mindmaps.json';

const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// In-memory cache
let cache = null;
let cacheSha = null;

// ===== GitHub API helpers =====
async function ghFetch(endpoint, opts = {}) {
  const url = `https://api.github.com${endpoint}`;
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Authorization': `token ${GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
      ...opts.headers
    }
  });
  return res;
}

async function loadFromGitHub() {
  try {
    const res = await ghFetch(`/repos/${GITHUB_REPO}/contents/${DATA_FILE}`);
    if (res.status === 200) {
      const data = await res.json();
      cacheSha = data.sha;
      const content = Buffer.from(data.content, 'base64').toString('utf8');
      cache = JSON.parse(content);
      console.log(`Loaded ${Object.keys(cache).length} mindmaps from GitHub`);
    } else {
      console.log('No existing data file, starting fresh');
      cache = {};
      cacheSha = null;
    }
  } catch (e) {
    console.error('GitHub load error:', e.message);
    cache = cache || {};
  }
}

async function saveToGitHub() {
  try {
    const content = Buffer.from(JSON.stringify(cache, null, 2)).toString('base64');
    const body = {
      message: `sync: ${Object.keys(cache).length} mindmaps @ ${new Date().toISOString()}`,
      content,
      ...(cacheSha ? { sha: cacheSha } : {})
    };
    const res = await ghFetch(`/repos/${GITHUB_REPO}/contents/${DATA_FILE}`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
    if (res.ok) {
      const data = await res.json();
      cacheSha = data.content.sha;
      console.log('Saved to GitHub');
    } else {
      const err = await res.text();
      console.error('GitHub save error:', res.status, err);
      // Reload to get fresh SHA and retry
      await loadFromGitHub();
    }
  } catch (e) {
    console.error('GitHub save error:', e.message);
  }
}

// Debounced save
let saveTimer = null;
function debouncedSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveToGitHub(), 2000);
}

// ===== HTTP Server =====
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 5e6) reject('too large'); });
    req.on('end', () => { try { resolve(JSON.parse(body)); } catch(e) { reject(e); } });
  });
}

function json(res, code, data) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // API: list all files
  if (url.pathname === '/api/files' && req.method === 'GET') {
    if (!cache) await loadFromGitHub();
    return json(res, 200, cache);
  }

  // API: save/update a file
  if (url.pathname === '/api/files' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      // body = { id, name, data, versions, updatedAt, createdAt }
      if (!body.id) return json(res, 400, { error: 'id required' });
      if (!cache) await loadFromGitHub();
      cache[body.id] = {
        name: body.name,
        data: body.data,
        versions: body.versions || [],
        updatedAt: body.updatedAt || Date.now(),
        createdAt: body.createdAt || cache[body.id]?.createdAt || Date.now()
      };
      debouncedSave();
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 400, { error: String(e) });
    }
  }

  // API: save all files at once (bulk sync)
  if (url.pathname === '/api/files/sync' && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      if (!cache) await loadFromGitHub();
      // body = { files: { id: fileData, ... } }
      Object.entries(body.files || body).forEach(([id, f]) => {
        if (id === 'files') return;
        cache[id] = {
          name: f.name,
          data: f.data,
          versions: f.versions || [],
          updatedAt: f.updatedAt || Date.now(),
          createdAt: f.createdAt || cache[id]?.createdAt || Date.now()
        };
      });
      debouncedSave();
      return json(res, 200, { ok: true, count: Object.keys(cache).length });
    } catch (e) {
      return json(res, 400, { error: String(e) });
    }
  }

  // API: delete a file
  if (url.pathname.startsWith('/api/files/') && req.method === 'DELETE') {
    const id = url.pathname.split('/').pop();
    if (!cache) await loadFromGitHub();
    delete cache[id];
    debouncedSave();
    return json(res, 200, { ok: true });
  }

  // Serve HTML
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
});

// Init
loadFromGitHub().then(() => {
  server.listen(PORT, () => console.log(`MindFlow running on port ${PORT}`));
});
