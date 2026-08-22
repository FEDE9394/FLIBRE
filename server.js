const http = require('node:http');
const { URL } = require('node:url');
const cheerio = require('cheerio');
// Converts generated SVG posters to PNG (Android Stremio cannot render SVG)
let sharp = null;
try { sharp = require('sharp'); } catch { /* optional dependency */ }

const BASE_URL = process.env.BASE_URL || 'https://futbollibre.ad/';
const AGENDA_URL = process.env.AGENDA_URL || 'https://futbollibretv.org.pe/diaries.json?v=2.2';
const USER_AGENT = process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const ICON_URL = process.env.ICON_URL || '';
const PORT = Number(process.env.PORT || 7010);
const cache = new Map();
const CACHE_TTL = 30 * 1000;

function log(message, error = false) {
  console[error ? 'error' : 'log'](`[futbollibre] ${message}`);
}

async function fetchText(url, referer = '') {
  const response = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
      ...(referer ? { Referer: referer } : {})
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.text();
}

async function cached(key, loader) {
  const current = cache.get(key);
  if (current && current.expiresAt > Date.now()) return current.value;
  const value = await loader();
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL });
  return value;
}

function absoluteUrl(value, base = BASE_URL) {
  if (!value) return '';
  try { return new URL(value, base).toString(); } catch { return ''; }
}

function parseChannels(html) {
  const $ = cheerio.load(html);
  const channels = [];
  const add = (title, url, image = '') => {
    if (!url || channels.some(channel => channel.url === url)) return;
    channels.push({ title: title.trim() || url.split('/').filter(Boolean).pop(), url, image });
  };
  $('.card').each((_, card) => {
    const link = $(card).find('.btn-watch, a').first();
    const href = link.attr('href');
    if (href) add($(card).find('h3').first().text(), absoluteUrl(href), absoluteUrl($(card).find('img').first().attr('src') || ''));
  });
  $('a[href*="/stream/"]').each((_, link) => {
    const href = $(link).attr('href');
    const container = $(link).parent();
    add($(link).text().replace(/\s+/g, ' '), absoluteUrl(href), absoluteUrl(container.find('img').first().attr('src') || ''));
  });
  return channels;
}

const MONTHS = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, octubre: 10, noviembre: 11, diciembre: 12
};

// Parses "Agenda - 22 de agosto de 2026" -> "22/8"
function parseAgendaDate(text) {
  const match = text.match(/(\d{1,2})\s+de\s+([a-záéíóúñ]+)/i);
  if (!match) return '';
  const day = Number(match[1]);
  const month = MONTHS[match[2].toLowerCase()];
  return month ? `${day}/${month}` : '';
}

function parseAgenda(html) {
  const $ = cheerio.load(html);
  const events = [];
  let currentDate = '';
  // Walk date headers and event articles in DOM order so each event gets its date
  $('.fl-agenda-date, article.fl-event').each((_, el) => {
    const node = $(el);
    if (node.is('.fl-agenda-date')) {
      currentDate = parseAgendaDate(node.text());
      return;
    }
    const hour = node.find('.fl-event-time').text().replace(/\s+/g, ' ').trim();
    const competition = node.find('.fl-event-competition').text().replace(/\s+/g, ' ').trim().replace(/:$/, '');
    let title = node.find('.fl-event-title').text().replace(/\s+/g, ' ').trim();
    if (competition) title = title.replace(competition, '').replace(/^\s*:?\s*/, '').trim();
    const image = absoluteUrl(node.find('img.fl-event-image').attr('src') || '');
    const options = node.find('.fl-event-channel').map((__, link) => ({
      title: $(link).text().replace(/\s+/g, ' ').trim() || 'Ver enlace',
      url: absoluteUrl($(link).attr('href'))
    })).get().filter(option => option.url);
    if (!options.length) return;
    // Readable title: [07:00] Competición: Evento (solo hora, son eventos del día)
    const fullTitle = `${hour ? `[${hour}] ` : ''}${competition ? `${competition}: ` : ''}${title}`;
    events.push({ title: fullTitle, date: currentDate, hour, image, options });
  });
  return events;
}

function parseAgendaJson(text) {
  const data = JSON.parse(text);
  return (data.data || []).map(item => {
    const attributes = item.attributes || {};
    const hour = attributes.diary_hour || '';
    const date = attributes.date_diary || '';
    const description = attributes.diary_description || 'Evento sin título';
    const agendaBase = AGENDA_URL.slice(0, AGENDA_URL.lastIndexOf('/') + 1);
    const options = (((attributes.embeds || {}).data) || []).map(embed => ({
      title: embed.attributes?.embed_name || 'Ver enlace',
      url: absoluteUrl(embed.attributes?.embed_iframe || '', agendaBase)
    })).filter(option => option.url);
    if (!options.length) return null;
    return { title: `${hour ? `[${hour}] ` : ''}${description}`, date, hour, image: '', options };
  }).filter(Boolean);
}

async function getChannels() {
  return cached('channels', async () => parseChannels(await fetchText(BASE_URL)));
}

async function getAgenda() {
  return cached('agenda', async () => {
    const htmlEvents = parseAgenda(await fetchText(BASE_URL));
    if (htmlEvents.length) return htmlEvents;
    return parseAgendaJson(await fetchText(AGENDA_URL, BASE_URL));
  });
}

function decodePlayback(html) {
  const direct = html.match(/(?:var|const|let)\s+playbackURL\s*=\s*["']([^"']+)["']/);
  if (direct) return direct[1].replaceAll('\\/', '/');
  const nums = [...html.matchAll(/function\s+\w+\(\)\s*\{\s*return\s+(\d+)\s*;\s*\}/g)].map(match => Number(match[1]));
  if (nums.length < 2) return '';
  const key = nums[0] + nums[1];
  const array = html.match(/\[(?:\[\d+\s*,\s*"[A-Za-z0-9+/=]+"\]\s*,?\s*)+\]/)?.[0];
  if (!array) return '';
  try {
    const chars = JSON.parse(array).sort((a, b) => a[0] - b[0]).map(([, value]) => {
      const digits = Buffer.from(value, 'base64').toString().replace(/\D/g, '');
      return String.fromCharCode(Number(digits) - key);
    });
    const result = chars.join('');
    return result.startsWith('http') ? result : '';
  } catch { return ''; }
}

async function resolveStream(channelUrl) {
  const parsedUrl = new URL(channelUrl);
  const encodedIframe = parsedUrl.searchParams.get('r');
  if (encodedIframe) {
    const iframeUrl = Buffer.from(encodedIframe, 'base64').toString('utf8');
    const stream = decodePlayback(await fetchText(iframeUrl, channelUrl));
    return stream ? { url: stream, referer: iframeUrl } : null;
  }
  const page = await fetchText(channelUrl);
  const $ = cheerio.load(page);
  const iframe = $('#embedIframe').first().attr('src') || $('iframe[src*="canal.php"]').first().attr('src') || $('iframe').first().attr('src');
  if (!iframe) return null;
  const iframeUrl = absoluteUrl(iframe, channelUrl).replace('tvhd2.com', 'fltvhd.com');
  const stream = decodePlayback(await fetchText(iframeUrl, channelUrl));
  return stream ? { url: stream, referer: iframeUrl } : null;
}

// ---- Generated posters (SVG) for items without artwork ----

const POSTER_COLORS = ['#1e3a8a', '#7c2d12', '#14532d', '#581c87', '#831843', '#0c4a6e', '#713f12', '#3f3f46'];

const XML_ESCAPES = { 38: 'amp', 60: 'lt', 62: 'gt', 34: 'quot', 39: 'apos' };

function normalizePosterText(text) {
  return String(text ?? '')
    .normalize('NFC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .trim();
}

function escapeXml(text) {
  return normalizePosterText(text).replace(/[&<>"']/g, char => '&' + XML_ESCAPES[char.charCodeAt(0)] + ';');
}

function wrapWords(title, maxCharsPerLine = 14, maxLines = 4) {
  const words = normalizePosterText(title).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > maxCharsPerLine && line) {
      lines.push(line.trim());
      line = word;
      if (lines.length === maxLines) break;
    } else {
      line = (line + ' ' + word).trim();
    }
  }
  if (line && lines.length < maxLines) lines.push(line.trim());
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = lines[maxLines - 1].slice(0, maxCharsPerLine - 1).trimEnd() + '...';
  }
  return lines;
}

function posterSvg(title) {
  const clean = normalizePosterText(title || '?').replace(/^[[\]]|[\][]/g, '').trim();
  const hash = [...clean].reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const bg = POSTER_COLORS[hash % POSTER_COLORS.length];
  const lines = wrapWords(clean.replace(/\s*:\s*/, ':\n').replace('\n', ' ') || '?');
  const startY = 300 - ((lines.length - 1) * 30);
  const textElements = lines.map((line, index) =>
    `<text x="200" y="${startY + index * 60}" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="34" font-weight="bold" fill="#ffffff" text-anchor="middle">${escapeXml(line)}</text>`
  ).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600" preserveAspectRatio="xMidYMid meet">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${bg}"/><stop offset="100%" stop-color="#000000"/></linearGradient></defs>
  <rect width="400" height="600" fill="url(#g)"/>
  ${textElements}
</svg>`;
}

// Cache for competition images embedded into agenda posters
const imageCache = new Map();

async function imageDataUri(url) {
  if (!url) return '';
  if (imageCache.has(url)) return imageCache.get(url);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(String(response.status));
    const buffer = Buffer.from(await response.arrayBuffer());
    const mime = response.headers.get('content-type') || 'image/png';
    const uri = 'data:' + mime + ';base64,' + buffer.toString('base64');
    imageCache.set(url, uri);
    return uri;
  } catch {
    return '';
  }
}

// Poster for agenda events: text only - big hour + full event name
function agendaPosterSvg(hour, eventName) {
  // Up to 10 short lines so long names are never cut off
  const lines = wrapWords(eventName || 'Evento', 15, 10);
  const fontSize = lines.length > 7 ? 24 : 28;
  const lineStep = fontSize + 8;
  const startY = 420 - ((lines.length - 1) * lineStep / 2);
  const textElements = lines.map((line, index) =>
    '<text x="200" y="' + Math.round(startY + index * lineStep) + '" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="' + fontSize + '" font-weight="bold" fill="#ffffff" text-anchor="middle">' + escapeXml(line) + '</text>'
  ).join('');
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600" preserveAspectRatio="xMidYMid meet">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#0f172a"/><stop offset="100%" stop-color="#000000"/></linearGradient></defs>' +
    '<rect width="400" height="600" fill="url(#g)"/>' +
    '<text x="200" y="150" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="88" font-weight="bold" fill="#fbbf24" text-anchor="middle">' + escapeXml(hour || '--:--') + '</text>' +
    '<rect x="50" y="185" width="300" height="4" fill="#fbbf24" opacity="0.6"/>' +
    textElements +
    '</svg>';
}

function badgePosterSvg(hour, eventName, badgeA, badgeB) {
  const nameLines = wrapWords(eventName || 'Evento', 18, 5);
  const textElements = nameLines.map((line, index) =>
    '<text x="200" y="' + (425 + index * 30) + '" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="24" font-weight="bold" fill="#ffffff" text-anchor="middle">' + escapeXml(line) + '</text>'
  ).join('');
  const image = (uri, x) => uri ? '<image href="' + escapeXml(uri) + '" x="' + x + '" y="145" width="130" height="130" preserveAspectRatio="xMidYMid meet"/>' : '';
  return '<?xml version="1.0" encoding="UTF-8"?>' +
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600">' +
    '<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#0f172a"/><stop offset="100%" stop-color="#000000"/></linearGradient></defs>' +
    '<rect width="400" height="600" fill="url(#g)"/>' +
    '<text x="200" y="95" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="64" font-weight="bold" fill="#fbbf24" text-anchor="middle">' + escapeXml(hour || '--:--') + '</text>' +
    image(badgeA, 35) + image(badgeB, 235) +
    '<text x="200" y="320" font-family="DejaVu Sans, Arial, Helvetica, sans-serif" font-size="34" font-weight="bold" fill="#fbbf24" text-anchor="middle">VS</text>' +
    textElements +
    '</svg>';
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  response.end(JSON.stringify(body));
}

function sendSvg(response, status, svg) {
  response.writeHead(status, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
  response.end(svg);
}

// Sends a poster as PNG when possible (better Android compatibility), SVG as fallback
async function sendPoster(response, status, svg) {
  if (sharp) {
    try {
      const png = await sharp(Buffer.from(svg), { density: 150 }).png().toBuffer();
      response.writeHead(status, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
      return response.end(png);
    } catch (error) {
      log('No se pudo convertir el poster a PNG: ' + error.message, true);
    }
  }
  sendSvg(response, status, svg);
}

// ---- HLS proxy: makes remote streams playable directly by Stremio ----

const b64e = value => Buffer.from(String(value), 'utf8').toString('base64url');
const b64d = value => Buffer.from(value, 'base64url').toString('utf8');

// Rewrites every URI inside an M3U8 playlist so requests pass through this server
function rewritePlaylist(text, sourceUrl, referer, request) {
  const proxied = target => `${localUrl(request, '/hls/fetch')}` +
    `?u=${encodeURIComponent(b64e(target))}&r=${encodeURIComponent(b64e(referer || ''))}`;
  return text.split('\n').map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith('#')) {
      // Rewrite URIs inside tags such as #EXT-X-KEY:URI="..." or #EXT-X-MAP:URI="..."
      return line.replace(/URI="([^"]+)"/g, (_, uri) => `URI="${proxied(absoluteUrl(uri, sourceUrl))}"`);
    }
    return proxied(absoluteUrl(trimmed, sourceUrl));
  }).join('\n');
}

async function hlsProxy(request, response, searchParams, isPlaylist) {
  const target = b64d(searchParams.get('u') || '');
  const referer = b64d(searchParams.get('r') || '');
  if (!target) return sendJson(response, 400, { error: 'Falta la URL del stream' });
  const upstream = await fetch(target, {
    headers: {
      'User-Agent': USER_AGENT,
      ...(referer ? { Referer: referer } : {})
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!upstream.ok) throw new Error(`${upstream.status} ${upstream.statusText}`);
  const contentType = upstream.headers.get('content-type') || '';
  // Variant playlists may arrive through /hls/fetch: detect them by URL or content-type
  const looksLikePlaylist = isPlaylist || /\.m3u8(\?|$)/i.test(target) || /mpegurl/i.test(contentType);
  if (looksLikePlaylist) {
    const body = await upstream.text();
    response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    return response.end(rewritePlaylist(body, target, referer, request));
  }
  // Segments / keys: stream binary through
  response.writeHead(200, {
    'Content-Type': contentType || 'application/octet-stream',
    'Access-Control-Allow-Origin': '*'
  });
  const reader = upstream.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      response.write(Buffer.from(value));
    }
  } finally {
    response.end();
  }
}

// Builds an absolute URL for local endpoints based on the incoming request
function localUrl(request, path) {
  const host = request.headers['x-forwarded-host'] || request.headers.host || `localhost:${PORT}`;
  const proto = request.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${host}${path}`;
}

const TOURNAMENT_WORDS = /\b(?:liga|league|copa|cup|torneo|tournament|uefa|conmebol|fifa|grand\s+prix|premier|profesional|professional|champions|mundial|world|qualifiers?|clasificaci[oó]n|fecha|jornada|semifinal|final)\b/gi;

function shortenParticipant(participant) {
  const clean = participant.replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  if (clean.length <= 9) return clean;
  const words = clean.split(' ').filter(Boolean);
  if (words.length > 1) {
    const acronym = words.map(word => word[0]).join('').toUpperCase();
    if (acronym.length >= 2 && acronym.length <= 4) return acronym;
  }
  return clean.slice(0, 8).trimEnd() + '.';
}

function formatTitle(originalTitle, time = '') {
  const original = String(originalTitle || '').replace(/^\[[^\]]+\]\s*/, '').trim();
  const withoutTournament = original
    .replace(TOURNAMENT_WORDS, '')
    .replace(/[|,:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const participants = withoutTournament.split(/\s+(?:vs\.?|v\.?|contra|at|@)\s+|\s+-\s+/i).map(shortenParticipant).filter(Boolean);
  const match = participants.length >= 2 ? `${participants[0]} vs ${participants[1]}` : shortenParticipant(withoutTournament || original);
  const clock = String(time || '').match(/\d{1,2}:\d{2}/)?.[0] || originalTitle.match(/^\[(\d{1,2}:\d{2})\]/)?.[1] || '';
  const prefix = clock ? `[${clock}] ` : '';
  const available = Math.max(1, 22 - prefix.length);
  return `${prefix}${match}`.slice(0, prefix.length + available).trimEnd();
}

const DEFAULT_POSTER = 'https://placehold.co/400x600/0f172a/fbbf24/png?text=Futbol+Libre';
const sportsDbPosterCache = new Map();
const promiedosBadgeCache = new Map();
let promiedosTeamsPromise;
const PROMIEDOS_URL = 'https://www.promiedos.com.ar/';
const PROMIEDOS_IMAGE_URL = 'https://api.promiedos.com.ar/images/team/';
const TEAM_SUFFIXES = /\b(?:fc|f\.c\.|club|s\.a\.d\.|sad|cf|c\.f\.)\b/gi;

function cleanTeamName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(TEAM_SUFFIXES, ' ')
    .replace(/[^a-z0-9 ]/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function teamTokens(value) {
  return new Set(cleanTeamName(value).split(' ').filter(token => token.length > 1));
}

function extractTeams(title) {
  const withoutTime = String(title || '').replace(/^\[[^\]]+\]\s*/, '');
  const withoutCompetition = withoutTime.replace(TOURNAMENT_WORDS, '').replace(/\s+/g, ' ').trim();
  const match = withoutCompetition.match(/^.*?\s+(?:vs\.?|v\.?|contra|at|@)\s+(.+)$/i) ||
    withoutCompetition.match(/^(.+?)\s+-\s+(.+)$/i);
  if (!match) return [];
  const separator = /\s+(?:vs\.?|v\.?|contra|at|@)\s+/i.test(withoutCompetition) ?
    withoutCompetition.match(/\s+(?:vs\.?|v\.?|contra|at|@)\s+/i) : withoutCompetition.match(/\s+-\s+/i);
  const teamA = withoutCompetition.slice(0, separator.index).replace(/^[^:]+:\s*/, '').trim();
  return teamA && match[1] ? [teamA, match[1].trim()] : [];
}

function eventMatchScore(eventName, teamA, teamB) {
  const eventTokens = teamTokens(eventName);
  const expected = [...teamTokens(teamA), ...teamTokens(teamB)];
  if (!expected.length) return 0;
  const matched = expected.filter(token => [...eventTokens].some(candidate => candidate === token || candidate.includes(token) || token.includes(candidate)));
  return matched.length / expected.length;
}

async function getEventPoster(teamA, teamB) {
  const names = [teamA, teamB].map(cleanTeamName);
  if (names.some(name => !name)) return DEFAULT_POSTER;
  const cacheKey = names.sort().join('|');
  if (sportsDbPosterCache.has(cacheKey)) return sportsDbPosterCache.get(cacheKey);

  const lookup = (async () => {
    try {
      const query = encodeURIComponent(`${teamA}_vs_${teamB}`);
      const response = await fetch(`https://www.thesportsdb.com/api/v1/json/123/searchevents.php?e=${query}`, {
        signal: AbortSignal.timeout(8000),
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) return DEFAULT_POSTER;
      const data = await response.json();
      const events = Array.isArray(data.event) ? data.event : [];
      const match = events
        .map(event => ({ event, score: eventMatchScore(event.strEvent, teamA, teamB) }))
        .filter(item => item.score >= 0.5)
        .sort((a, b) => b.score - a.score)[0]?.event;
      return match?.strPoster || match?.strThumb || '';
    } catch {
      return '';
    }
  })();
  sportsDbPosterCache.set(cacheKey, lookup);
  return (await lookup) || DEFAULT_POSTER;
}

async function findSportsDbPoster(teamA, teamB) {
  const poster = await getEventPoster(teamA, teamB);
  return poster === DEFAULT_POSTER ? '' : poster;
}

async function getPromiedosTeams() {
  if (!promiedosTeamsPromise) {
    promiedosTeamsPromise = (async () => {
      try {
        const response = await fetch(PROMIEDOS_URL, { signal: AbortSignal.timeout(10000) });
        if (!response.ok) return [];
        const html = await response.text();
        const teams = [];
        const pattern = /\{"name":"([^"\\]*(?:\\.[^"\\]*)*)","short_name":"([^"\\]*)","url_name":"([^"\\]*)","id":"([a-z0-9]+)"/gi;
        for (const match of html.matchAll(pattern)) {
          teams.push({ name: match[1], shortName: match[2], id: match[4] });
        }
        return teams;
      } catch {
        return [];
      }
    })();
  }
  return promiedosTeamsPromise;
}

async function getPromiedosBadge(teamName) {
  const key = cleanTeamName(teamName);
  if (!key) return '';
  if (promiedosBadgeCache.has(key)) return promiedosBadgeCache.get(key);
  const lookup = (async () => {
    const teams = await getPromiedosTeams();
    const match = teams
      .map(team => ({ team, score: eventMatchScore(team.name, teamName, teamName) }))
      .filter(item => item.score >= 0.5)
      .sort((a, b) => b.score - a.score)[0]?.team;
    return match ? `${PROMIEDOS_IMAGE_URL}${encodeURIComponent(match.id)}/4` : '';
  })();
  promiedosBadgeCache.set(key, lookup);
  return lookup;
}

async function getEventArtwork(event) {
  const teams = extractTeams(event.title);
  if (teams.length !== 2) return { poster: DEFAULT_POSTER };
  const sportsDbPoster = await findSportsDbPoster(teams[0], teams[1]);
  if (sportsDbPoster) return { poster: sportsDbPoster };
  const [badgeA, badgeB] = await Promise.all([getPromiedosBadge(teams[0]), getPromiedosBadge(teams[1])]);
  return badgeA && badgeB ? { badges: [badgeA, badgeB] } : { poster: DEFAULT_POSTER };
}

async function getEventPosterFor(event) {
  const teams = extractTeams(event.title);
  return teams.length === 2 ? getEventPoster(teams[0], teams[1]) : DEFAULT_POSTER;
}

function meta(id, type, name, description = '') {
  return { id, type, name, ...(description ? { description } : {}) };
}

async function router(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    pathname = url.pathname;
  }

  // Generated poster endpoint: /poster/<title>.svg
  const posterMatch = pathname.match(/^\/poster\/(.+)\.svg$/i);
  if (posterMatch) {
    return sendPoster(response, 200, posterSvg(posterMatch[1]));
  }

  // Agenda event poster: /agenda-poster/<index>-<hash>.svg (hash busts Stremio's image cache)
  const agendaPosterMatch = pathname.match(/^\/agenda-poster\/(\d+)(?:-([a-z0-9]+))?\.svg$/i);
  if (agendaPosterMatch) {
    const event = (await getAgenda())[Number(agendaPosterMatch[1])];
    if (!event) return sendPoster(response, 404, posterSvg('Evento no encontrado'));
    const artwork = await getEventArtwork(event);
    if (artwork.poster && artwork.poster !== DEFAULT_POSTER) {
      response.writeHead(302, { Location: artwork.poster, 'Cache-Control': 'public, max-age=86400' });
      return response.end();
    }
    if (artwork.badges) {
      const [badgeA, badgeB] = await Promise.all(artwork.badges.map(imageDataUri));
      if (badgeA && badgeB) {
        const eventName = event.title.replace(/^\[[^\]]+\]\s*/, '');
        return sendPoster(response, 200, badgePosterSvg(event.hour, eventName, badgeA, badgeB));
      }
    }
    // Strip the "[hh:mm] " prefix from the title for the poster text
    const eventName = event.title.replace(/^\[[^\]]+\]\s*/, '');
    return sendPoster(response, 200, agendaPosterSvg(event.hour, eventName));
  }

  // HLS proxy endpoints
  if (pathname === '/hls/master.m3u8' || pathname === '/hls/media.m3u8') {
    return hlsProxy(request, response, url.searchParams, true);
  }
  if (pathname === '/hls/fetch') {
    return hlsProxy(request, response, url.searchParams, false);
  }

  if (pathname === '/manifest.json') {
    return sendJson(response, 200, {
      id: 'community.futbollibre', version: '1.2.0', name: 'Fútbol Libre', description: 'Canales deportivos y agenda de partidos',
      logo: ICON_URL || undefined,
      resources: ['catalog', 'meta', 'stream'], types: ['tv', 'movie'], catalogs: [
        { type: 'tv', id: 'channels', name: 'Canales en vivo' }, { type: 'tv', id: 'agenda', name: 'Agenda de partidos' }
      ], idPrefixes: ['channel:', 'event:']
    });
  }
  if (pathname === '/catalog/tv/channels.json') {
    const channels = await getChannels();
    return sendJson(response, 200, {
      metas: channels.map(channel => meta(
        `channel:${encodeURIComponent(channel.url)}`, 'tv', channel.title,
        channel.image || localUrl(request, `/poster/${encodeURIComponent(channel.title)}.svg`)
      ))
    });
  }
  if (pathname === '/catalog/tv/agenda.json') {
    const events = await getAgenda();
    return sendJson(response, 200, {
      metas: await Promise.all(events.map(async (event, index) => {
        const item = meta(`event:${index}`, 'tv', event.title, event.title);
        const artwork = await getEventArtwork(event);
        const hash = Buffer.from(event.title, 'utf8').toString('base64url').replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase();
        item.poster = artwork.badges ? localUrl(request, `/agenda-poster/${index}-${hash}.svg`) : artwork.poster;
        return item;
      }))
    });
  }
  const channelMatch = pathname.match(/^\/meta\/tv\/channel:(.+)\.json$/);
  if (channelMatch) {
    const channelUrl = decodeURIComponent(channelMatch[1]);
    const channel = (await getChannels()).find(item => item.url === channelUrl);
    return sendJson(response, channel ? 200 : 404, channel ? {
      meta: meta(`channel:${encodeURIComponent(channel.url)}`, 'tv', channel.title,
        channel.image || localUrl(request, `/poster/${encodeURIComponent(channel.title)}.svg`))
    } : { error: 'Canal no encontrado' });
  }
  const eventMatch = pathname.match(/^\/meta\/tv\/event:(\d+)\.json$/);
  if (eventMatch) {
    const event = (await getAgenda())[Number(eventMatch[1])];
    if (!event) return sendJson(response, 404, { error: 'Evento no encontrado' });
    const eventMeta = meta(`event:${eventMatch[1]}`, 'tv', event.title, event.title);
    const artwork = await getEventArtwork(event);
    const hash = Buffer.from(event.title, 'utf8').toString('base64url').replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase();
    eventMeta.poster = artwork.badges ? localUrl(request, `/agenda-poster/${eventMatch[1]}-${hash}.svg`) : artwork.poster;
    return sendJson(response, 200, { meta: eventMeta });
  }
  // Wraps a resolved stream through the local HLS proxy so any Stremio client can play it
  function proxiedStream(resolved, name, title) {
    const proxyUrl = `${localUrl(request, '/hls/master.m3u8')}?u=${encodeURIComponent(b64e(resolved.url))}&r=${encodeURIComponent(b64e(resolved.referer || ''))}`;
    return { name, title, url: proxyUrl };
  }

  const streamMatch = pathname.match(/^\/stream\/tv\/channel:(.+)\.json$/);
  if (streamMatch) {
    const resolved = await resolveStream(decodeURIComponent(streamMatch[1]));
    return sendJson(response, resolved ? 200 : 404, { streams: resolved ? [proxiedStream(resolved, 'Fútbol Libre', 'Reproducir')] : [] });
  }
  const eventStreamMatch = pathname.match(/^\/stream\/tv\/event:(\d+)\.json$/);
  if (eventStreamMatch) {
    const event = (await getAgenda())[Number(eventStreamMatch[1])];
    const streams = [];
    for (const option of event?.options || []) {
      try {
        const resolved = await resolveStream(option.url);
        if (resolved) streams.push(proxiedStream(resolved, option.title, option.title));
      } catch (error) {
        log(`No se pudo resolver ${option.url}: ${error.message}`, true);
      }
    }
    return sendJson(response, 200, { streams });
  }
  if (pathname === '/') return sendJson(response, 200, { name: 'Fútbol Libre Stremio Addon', manifest: '/manifest.json' });
  return sendJson(response, 404, { error: 'Ruta no encontrada' });
}

const handler = (request, response) => router(request, response).catch(error => {
  log(error.message, true);
  sendJson(response, 502, { error: 'No se pudo consultar la fuente' });
});

if (require.main === module) {
  const server = http.createServer(handler);
  server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      log(`El puerto ${PORT} ya está en uso por otra aplicación.`, true);
      log(`Cierra esa aplicación o inicia este addon con otro puerto, por ejemplo: set PORT=7020 && node server.js`, true);
      process.exit(1);
    }
    throw error;
  });
  server.listen(PORT, '0.0.0.0', () => log(`Servidor escuchando en http://localhost:${PORT}`));
}

module.exports = handler;