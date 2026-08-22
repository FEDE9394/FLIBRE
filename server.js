const http = require('node:http');
const { URL } = require('node:url');
const cheerio = require('cheerio');

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
    // Readable title: [22/8 07:00] Competición: Evento
    const whenParts = [currentDate, hour].filter(Boolean).join(' ');
    const fullTitle = `${whenParts ? `[${whenParts}] ` : ''}${competition ? `${competition}: ` : ''}${title}`;
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
    const whenParts = [date, hour].filter(Boolean).join(' ');
    return { title: `${whenParts ? `[${whenParts}] ` : ''}${description}`, date, hour, image: '', options };
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

function escapeXml(text) {
  return String(text).replace(/[&<>"']/g, char => '&' + XML_ESCAPES[char.charCodeAt(0)] + ';');
}

function wrapWords(title, maxCharsPerLine = 14, maxLines = 4) {
  const words = String(title).split(/\s+/).filter(Boolean);
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
    lines[maxLines - 1] = lines[maxLines - 1].slice(0, maxCharsPerLine - 1).trimEnd() + '…';
  }
  return lines;
}

function posterSvg(title) {
  const clean = String(title || '?').replace(/^[[\]]|[\][]/g, '').trim();
  const hash = [...clean].reduce((acc, char) => acc + char.charCodeAt(0), 0);
  const bg = POSTER_COLORS[hash % POSTER_COLORS.length];
  const lines = wrapWords(clean.replace(/\s*:\s*/, ':\n').replace('\n', ' ') || '?');
  const startY = 300 - ((lines.length - 1) * 30);
  const textElements = lines.map((line, index) =>
    `<text x="200" y="${startY + index * 60}" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="bold" fill="#ffffff" text-anchor="middle">${escapeXml(line)}</text>`
  ).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600" viewBox="0 0 400 600">
  <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${bg}"/><stop offset="100%" stop-color="#000000"/></linearGradient></defs>
  <rect width="400" height="600" fill="url(#g)"/>
  <circle cx="200" cy="140" r="60" fill="rgba(255,255,255,0.12)"/>
  <path d="M200 95 L238 122 L224 166 L176 166 L162 122 Z" fill="rgba(255,255,255,0.35)"/>
  ${textElements}
</svg>`;
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  response.end(JSON.stringify(body));
}

function sendSvg(response, status, svg) {
  response.writeHead(status, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400', 'Access-Control-Allow-Origin': '*' });
  response.end(svg);
}

// Builds an absolute URL for local endpoints based on the incoming request
function localUrl(request, path) {
  const host = request.headers['x-forwarded-host'] || request.headers.host || `localhost:${PORT}`;
  const proto = request.headers['x-forwarded-proto'] || 'http';
  return `${proto}://${host}${path}`;
}

function meta(id, type, name, poster = '') {
  return { id, type, name, ...(poster ? { poster } : {}) };
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
    return sendSvg(response, 200, posterSvg(posterMatch[1]));
  }

  if (pathname === '/manifest.json') {
    return sendJson(response, 200, {
      id: 'community.futbollibre', version: '1.1.0', name: 'Fútbol Libre', description: 'Canales deportivos y agenda de partidos',
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
      metas: events.map((event, index) => meta(
        `event:${index}`, 'tv', event.title,
        event.image || localUrl(request, `/poster/${encodeURIComponent(event.title)}.svg`)
      ))
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
    return sendJson(response, event ? 200 : 404, event ? {
      meta: meta(`event:${eventMatch[1]}`, 'tv', event.title,
        event.image || localUrl(request, `/poster/${encodeURIComponent(event.title)}.svg`))
    } : { error: 'Evento no encontrado' });
  }
  const streamMatch = pathname.match(/^\/stream\/tv\/channel:(.+)\.json$/);
  if (streamMatch) {
    const resolved = await resolveStream(decodeURIComponent(streamMatch[1]));
    return sendJson(response, resolved ? 200 : 404, { streams: resolved ? [{ name: 'Fútbol Libre', title: 'Reproducir', url: resolved.url, behaviorHints: { notWebReady: true }, headers: { Referer: resolved.referer, 'User-Agent': USER_AGENT } }] : [] });
  }
  const eventStreamMatch = pathname.match(/^\/stream\/tv\/event:(\d+)\.json$/);
  if (eventStreamMatch) {
    const event = (await getAgenda())[Number(eventStreamMatch[1])];
    const streams = [];
    for (const option of event?.options || []) {
      try {
        const resolved = await resolveStream(option.url);
        if (resolved) streams.push({ name: option.title, title: option.title, url: resolved.url, behaviorHints: { notWebReady: true }, headers: { Referer: resolved.referer, 'User-Agent': USER_AGENT } });
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