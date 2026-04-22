// Odyssée Rabat — Admin write proxy
// POST /.netlify/functions/admin-write
// Body JSON: { pin: "8247", action: "<module>.<verb>", payload: { ... } }
//
// Env vars requises (Netlify → Site settings → Environment):
//   ADMIN_PIN       ex: 8247
//   GITHUB_TOKEN    fine-grained PAT avec Contents Read/Write sur le repo
//   GITHUB_REPO     ex: mlahbabi/odyssee-rabat
//   GITHUB_BRANCH   ex: main

const GH = 'https://api.github.com';

// ---------- Helpers ----------
function now() { return new Date().toISOString().replace(/\.\d+Z$/, 'Z'); }

function json(status, body) {
  return {
    statusCode: status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    },
    body: JSON.stringify(body)
  };
}

function ghHeaders(token) {
  return {
    'Accept': 'application/vnd.github+json',
    'Authorization': 'Bearer ' + token,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'odyssee-rabat-admin'
  };
}

async function ghGetJson(repo, branch, path, token) {
  const url = `${GH}/repos/${repo}/contents/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
  const res = await fetch(url, { headers: ghHeaders(token) });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`GET ${path} failed: ${res.status} ${txt.slice(0, 200)}`);
  }
  const meta = await res.json();
  const decoded = Buffer.from(meta.content, 'base64').toString('utf-8');
  let data;
  try { data = JSON.parse(decoded); }
  catch (e) { throw new Error(`Invalid JSON at ${path}: ${e.message}`); }
  return { data, sha: meta.sha };
}

async function ghPutJson(repo, branch, path, data, sha, message, token) {
  const url = `${GH}/repos/${repo}/contents/${encodeURIComponent(path)}`;
  const body = {
    message,
    branch,
    sha,
    content: Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf-8').toString('base64')
  };
  const res = await fetch(url, {
    method: 'PUT',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`PUT ${path} failed: ${res.status} ${txt.slice(0, 300)}`);
  }
  return res.json();
}

// ---------- Actions ----------
const ACTIONS = {
  // Scoreboard
  'scoreboard.delta': ({ data, payload }) => {
    const teamId = Number(payload.teamId);
    const delta = Number(payload.delta);
    if (!Number.isFinite(teamId) || !Number.isFinite(delta)) throw new Error('teamId et delta requis');
    const team = data.teams.find(t => t.id === teamId);
    if (!team) throw new Error(`Équipe ${teamId} introuvable`);
    team.score = Math.max(0, (team.score || 0) + delta);
    return { teamId, delta, newScore: team.score };
  },
  'scoreboard.setScore': ({ data, payload }) => {
    const teamId = Number(payload.teamId);
    const score = Number(payload.score);
    if (!Number.isFinite(teamId) || !Number.isFinite(score)) throw new Error('teamId et score requis');
    const team = data.teams.find(t => t.id === teamId);
    if (!team) throw new Error(`Équipe ${teamId} introuvable`);
    team.score = Math.max(0, score);
    return { teamId, newScore: team.score };
  },
  'scoreboard.setStatus': ({ data, payload }) => {
    const { status, statusLabel, round, totalRounds } = payload || {};
    if (status) data.status = status;
    if (statusLabel) data.statusLabel = statusLabel;
    if (typeof round === 'number') data.round = round;
    if (typeof totalRounds === 'number') data.totalRounds = totalRounds;
    return { status: data.status, round: data.round };
  },
  'scoreboard.resetAll': ({ data }) => {
    data.teams.forEach(t => t.score = 0);
    data.round = 0;
    data.status = 'pre-event';
    data.statusLabel = "En attente du coup d'envoi";
    return { reset: true };
  },

  // Photos (modération)
  'photos.hide': ({ data, payload }) => {
    const id = String(payload.id || '').trim();
    if (!id) throw new Error('id requis');
    if (!Array.isArray(data.hiddenIds)) data.hiddenIds = [];
    if (!data.hiddenIds.includes(id)) data.hiddenIds.push(id);
    return { hiddenIds: data.hiddenIds };
  },
  'photos.unhide': ({ data, payload }) => {
    const id = String(payload.id || '').trim();
    if (!Array.isArray(data.hiddenIds)) data.hiddenIds = [];
    data.hiddenIds = data.hiddenIds.filter(x => x !== id);
    return { hiddenIds: data.hiddenIds };
  },
  'photos.clearAll': ({ data }) => {
    data.hiddenIds = [];
    return { hiddenIds: [] };
  },

  // Notifications
  'notifs.push': ({ data, payload }) => {
    const { title, body, level } = payload || {};
    if (!title && !body) throw new Error('title ou body requis');
    if (!Array.isArray(data.notifs)) data.notifs = [];
    const id = 'n_' + Date.now().toString(36);
    data.notifs.unshift({
      id,
      ts: now(),
      title: String(title || '').slice(0, 140),
      body: String(body || '').slice(0, 500),
      level: level === 'urgent' ? 'urgent' : (level === 'info' ? 'info' : 'normal')
    });
    // Garde les 20 dernières
    data.notifs = data.notifs.slice(0, 20);
    return { pushed: id };
  },
  'notifs.delete': ({ data, payload }) => {
    const id = String(payload.id || '').trim();
    if (!Array.isArray(data.notifs)) data.notifs = [];
    data.notifs = data.notifs.filter(n => n.id !== id);
    return { remaining: data.notifs.length };
  },
  'notifs.clearAll': ({ data }) => {
    data.notifs = [];
    return { cleared: true };
  }
};

const FILE_FOR_MODULE = {
  scoreboard: 'data/scoreboard.json',
  photos: 'data/photo-moderation.json',
  notifs: 'data/notifications.json'
};

// ---------- Handler ----------
exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: { 'Access-Control-Allow-Origin': '*' } };
  }
  if (event.httpMethod !== 'POST') return json(405, { error: 'POST only' });

  const { ADMIN_PIN, GITHUB_TOKEN, GITHUB_REPO, GITHUB_BRANCH } = process.env;
  if (!ADMIN_PIN || !GITHUB_TOKEN || !GITHUB_REPO) {
    return json(500, { error: 'Config serveur incomplète (env vars manquantes)' });
  }
  const branch = GITHUB_BRANCH || 'main';

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Body JSON invalide' }); }

  if (String(body.pin || '') !== String(ADMIN_PIN)) {
    return json(401, { error: 'PIN invalide' });
  }

  const action = String(body.action || '');
  const [moduleKey, verb] = action.split('.');
  const fn = ACTIONS[action];
  const filePath = FILE_FOR_MODULE[moduleKey];
  if (!fn || !filePath) return json(400, { error: `Action inconnue: ${action}` });

  try {
    const { data, sha } = await ghGetJson(GITHUB_REPO, branch, filePath, GITHUB_TOKEN);
    const actionResult = fn({ data, payload: body.payload || {} });
    data.updatedAt = now();
    const message = `admin: ${action}${actionResult && actionResult.teamId ? ` team=${actionResult.teamId}` : ''}`;
    const commit = await ghPutJson(GITHUB_REPO, branch, filePath, data, sha, message, GITHUB_TOKEN);
    return json(200, {
      ok: true,
      action,
      result: actionResult,
      commit: commit.commit && commit.commit.sha ? commit.commit.sha.slice(0, 7) : null,
      updatedAt: data.updatedAt
    });
  } catch (err) {
    return json(500, { error: err.message || String(err) });
  }
};
