const http = require('node:http');
const { URL } = require('node:url');
const cheerio = require('cheerio');

const PORT = Number(process.env.PORT || 7000);
const BASE_URL = process.env.BASE_URL || 'https://futbollibre.ad/';
const AGENDA_URL = process.env.AGENDA_URL || 'https://futbollibretv.org.pe/diaries.json?v=2.2';
const USER_AGENT = process.env.USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const ICON_URL = process.env.ICON_URL || '';
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

function parseAgenda(html) {
  const $ = cheerio.load(html);
  return $('article.fl-event').map((_, article) => {
    const hour = $(article).find('.fl-event-time').text().replace(/\s+/g, ' ').trim();
    const competition = $(article).find('.fl-event-competition').text().replace(/\s+/g, ' ').trim();
    let title = $(article).find('.fl-event-title').text().replace(/\s+/g, ' ').trim();
    if (competition) title = title.replace(competition, '').trim();
    const options = $(article).find('.fl-event-channel').map((__, link) => ({
      title: $(link).text().replace(/\s+/g, ' ').trim() || 'Ver enlace',
      url: absoluteUrl($(link).attr('href'))
    })).get().filter(option => option.url);
    return options.length ? { title: hour ? `[${hour}] ${title}` : title, options } : null;
  }).get().filter(Boolean);
}

function parseAgendaJson(text) {
  const data = JSON.parse(text);
  return (data.data || []).map(item => {
    const attributes = item.attributes || {};
    const hour = attributes.diary_hour || '';
    const title = hour ? `[${hour}] ${attributes.diary_description || 'Evento sin título'}` : (attributes.diary_description || 'Evento sin título');
    const agendaBase = AGENDA_URL.slice(0, AGENDA_URL.lastIndexOf('/') + 1);
    const options = (((attributes.embeds || {}).data) || []).map(embed => ({
      title: embed.attributes?.embed_name || 'Ver enlace',
      url: absoluteUrl(embed.attributes?.embed_iframe || '', agendaBase)
    })).filter(option => option.url);
    return options.length ? { title, options } : null;
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

function sendJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  response.end(JSON.stringify(body));
}

function meta(id, type, name, poster = ICON_URL) {
  return { id, type, name, ...(poster ? { poster } : {}) };
}

async function router(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (url.pathname === '/manifest.json') {
    return sendJson(response, 200, {
      id: 'community.futbollibre', version: '1.0.0', name: 'Fútbol Libre', description: 'Canales deportivos y agenda de partidos', logo: ICON_URL || undefined,
      resources: ['catalog', 'meta', 'stream'], types: ['tv', 'movie'], catalogs: [
        { type: 'tv', id: 'channels', name: 'Canales en vivo' }, { type: 'tv', id: 'agenda', name: 'Agenda de partidos' }
      ], idPrefixes: ['channel:', 'event:']
    });
  }
  if (url.pathname === '/catalog/tv/channels.json') {
    const channels = await getChannels();
    return sendJson(response, 200, { metas: channels.map(channel => meta(`channel:${encodeURIComponent(channel.url)}`, 'tv', channel.title, channel.image || ICON_URL)) });
  }
  if (url.pathname === '/catalog/tv/agenda.json') {
    const events = await getAgenda();
    return sendJson(response, 200, { metas: events.map((event, index) => meta(`event:${index}`, 'tv', event.title, ICON_URL)) });
  }
  const channelMatch = url.pathname.match(/^\/meta\/tv\/channel:(.+)\.json$/);
  if (channelMatch) {
    const channelUrl = decodeURIComponent(channelMatch[1]);
    const channel = (await getChannels()).find(item => item.url === channelUrl);
    return sendJson(response, channel ? 200 : 404, channel ? { meta: meta(`channel:${encodeURIComponent(channel.url)}`, 'tv', channel.title, channel.image || ICON_URL) } : { error: 'Canal no encontrado' });
  }
  const eventMatch = url.pathname.match(/^\/meta\/tv\/event:(\d+)\.json$/);
  if (eventMatch) {
    const event = (await getAgenda())[Number(eventMatch[1])];
    return sendJson(response, event ? 200 : 404, event ? { meta: meta(`event:${eventMatch[1]}`, 'tv', event.title, ICON_URL) } : { error: 'Evento no encontrado' });
  }
  const streamMatch = url.pathname.match(/^\/stream\/tv\/channel:(.+)\.json$/);
  if (streamMatch) {
    const resolved = await resolveStream(decodeURIComponent(streamMatch[1]));
    return sendJson(response, resolved ? 200 : 404, { streams: resolved ? [{ name: 'Fútbol Libre', title: 'Reproducir', url: resolved.url, behaviorHints: { notWebReady: true }, headers: { Referer: resolved.referer, 'User-Agent': USER_AGENT } }] : [] });
  }
  const eventStreamMatch = url.pathname.match(/^\/stream\/tv\/event:(\d+)\.json$/);
  if (eventStreamMatch) {
    const event = (await getAgenda())[Number(eventStreamMatch[1])];
    const streams = [];
    for (const option of event?.options || []) {
      const resolved = await resolveStream(option.url);
      if (resolved) streams.push({ name: option.title, title: option.title, url: resolved.url, behaviorHints: { notWebReady: true }, headers: { Referer: resolved.referer, 'User-Agent': USER_AGENT } });
    }
    return sendJson(response, 200, { streams });
  }
  if (url.pathname === '/') return sendJson(response, 200, { name: 'Fútbol Libre Stremio Addon', manifest: '/manifest.json' });
  return sendJson(response, 404, { error: 'Ruta no encontrada' });
}

const server = http.createServer((request, response) => router(request, response).catch(error => { log(error.message, true); sendJson(response, 502, { error: 'No se pudo consultar la fuente' }); }));
server.listen(PORT, '0.0.0.0', () => log(`Servidor escuchando en http://localhost:${PORT}`));