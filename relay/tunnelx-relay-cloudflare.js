// TunnelX relay for Cloudflare Workers — paste this whole file as worker.js.
// Optional secret: Settings → Variables → add KEY.
// Note: Workers cannot add extra root certificates, so sites using only the Russian national CA will fail here; use the Deno relay for those.
import { connect } from 'cloudflare:sockets';
const RELAY_TYPE = 'cf-v1';
const EXTRA_FEATURES = [];
function wrap(s) {
  const r = s.readable.getReader(), w = s.writable.getWriter();
  return {
    async read() { const { value, done } = await r.read(); return done ? null : value; },
    async write(u) { await w.write(u); },
    close() { try { s.close(); } catch (_) { /* already closed */ } },
    async startTls(h) { r.releaseLock(); w.releaseLock(); return wrap(s.startTls({ expectedServerHostname: h })); },
  };
}
async function dial(host, port) {
  const s = connect({ hostname: host, port }, { secureTransport: 'starttls' });
  await withTimeout(s.opened, 8000, 'proxy connect');
  return wrap(s);
}
// ---- TunnelX relay core (shared by Deno and Cloudflare builds) ----
// Endpoints: /health  /test?host=&port=&proto=  /fetch?url=&proxy=proto://host:port
// Optional secret: set KEY, then add &k=KEY to every call (TunnelX does this for you).
const enc = new TextEncoder(), dec = new TextDecoder();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const MAX_BYTES = 20 * 1024 * 1024;
const IP_ECHO = 'http://checkip.amazonaws.com/';

function withTimeout(p, ms, what) {
  let t; return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(what + ' timed out')), ms); })]).finally(() => clearTimeout(t));
}
function concat(a, b) { const n = new Uint8Array(a.length + b.length); n.set(a); n.set(b, a.length); return n; }
function indexOfCRLF2(b) { for (let i = 0; i + 3 < b.length; i++) if (b[i] === 13 && b[i + 1] === 10 && b[i + 2] === 13 && b[i + 3] === 10) return i; return -1; }

class Buf {
  constructor(raw) { this.raw = raw; this.b = new Uint8Array(0); }
  async fill() { const c = await this.raw.read(); if (!c) return false; this.b = concat(this.b, c); return true; }
  async take(n) { while (this.b.length < n) if (!(await this.fill())) throw new Error('proxy closed the connection'); const r = this.b.slice(0, n); this.b = this.b.slice(n); return r; }
  async head() { let i; while ((i = indexOfCRLF2(this.b)) < 0) { if (this.b.length > 65536 || !(await this.fill())) throw new Error('bad response from proxy'); } const h = dec.decode(this.b.slice(0, i)); this.b = this.b.slice(i + 4); return h; }
  async rest() { while (this.b.length < MAX_BYTES && await this.fill()); return this.b; }
}

function hostBytes(h) { const b = enc.encode(h); if (b.length > 255) throw new Error('host too long'); return b; }

async function socks5(raw, buf, host, port) {
  await raw.write(new Uint8Array([5, 1, 0]));
  const g = await buf.take(2); if (g[0] !== 5 || g[1] !== 0) throw new Error('SOCKS5 refused (needs login?)');
  const h = hostBytes(host);
  await raw.write(new Uint8Array([5, 1, 0, 3, h.length, ...h, port >> 8, port & 255]));
  const r = await buf.take(4); if (r[1] !== 0) throw new Error('SOCKS5 connect failed, code ' + r[1]);
  if (r[3] === 1) await buf.take(6); else if (r[3] === 4) await buf.take(18); else { const l = await buf.take(1); await buf.take(l[0] + 2); }
}
async function socks4a(raw, buf, host, port) {
  await raw.write(new Uint8Array([4, 1, port >> 8, port & 255, 0, 0, 0, 1, 0, ...hostBytes(host), 0]));
  const r = await buf.take(8); if (r[1] !== 0x5a) throw new Error('SOCKS4 refused, code ' + r[1]);
}
async function httpConnect(raw, buf, host, port) {
  await raw.write(enc.encode(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nUser-Agent: ${UA}\r\n\r\n`));
  const h = await buf.head(); const code = +(h.split(' ')[1] || 0);
  if (code !== 200) throw new Error('HTTP proxy CONNECT returned ' + code);
}

function parseProxy(s) {
  const m = /^(socks5h?|socks4a?|https?):\/\/([^:/\s]+):(\d{1,5})$/i.exec(s || '');
  if (!m) throw new Error('proxy must look like socks5://host:port');
  return { protocol: m[1].toLowerCase().replace(/h$|a$/, ''), host: m[2], port: +m[3] };
}

// One HTTP/1.1 exchange through the proxy. Returns {status, headers, body}.
async function exchange(proxy, url, lang) {
  const u = new URL(url), tls = u.protocol === 'https:', port = +(u.port || (tls ? 443 : 80));
  const isHttpProxy = proxy.protocol === 'http' || proxy.protocol === 'https';
  const direct = isHttpProxy && !tls;               // plain http via HTTP proxy: absolute-form request, no CONNECT
  let raw = await dial(proxy.host, proxy.port);
  try {
    let buf = new Buf(raw);
    if (!direct) {
      if (proxy.protocol === 'socks5') await socks5(raw, buf, u.hostname, port);
      else if (proxy.protocol === 'socks4') await socks4a(raw, buf, u.hostname, port);
      else await httpConnect(raw, buf, u.hostname, port);
      if (tls) { raw = await raw.startTls(u.hostname); buf = new Buf(raw); }
    }
    const target = direct ? u.href : (u.pathname + u.search);
    await raw.write(enc.encode(
      `GET ${target} HTTP/1.1\r\nHost: ${u.host}\r\nUser-Agent: ${UA}\r\n` +
      `Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8\r\n` +
      `Accept-Language: ${lang}\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n`));
    const head = await buf.head();
    const lines = head.split('\r\n'), status = +(lines[0].split(' ')[1] || 0), headers = {};
    for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
    let body = await buf.rest();
    if (/chunked/i.test(headers['transfer-encoding'] || '')) body = dechunk(body);
    else if (headers['content-length']) body = body.slice(0, +headers['content-length']);
    return { status, headers, body };
  } finally { raw.close(); }
}
function dechunk(b) {
  const out = []; let i = 0, total = 0;
  while (i < b.length) {
    let j = i; while (j + 1 < b.length && !(b[j] === 13 && b[j + 1] === 10)) j++;
    const size = parseInt(dec.decode(b.slice(i, j)).split(';')[0], 16); if (!size || isNaN(size)) break;
    out.push(b.slice(j + 2, j + 2 + size)); total += size; i = j + 2 + size + 2;
  }
  const r = new Uint8Array(total); let o = 0; for (const c of out) { r.set(c, o); o += c.length; } return r;
}
async function fetchVia(proxy, url, lang) {
  for (let hop = 0; hop < 6; hop++) {
    const r = await exchange(proxy, url, lang);
    if (r.status >= 300 && r.status < 400 && r.headers.location) { url = new URL(r.headers.location, url).href; continue; }
    r.finalUrl = url; return r;
  }
  throw new Error('too many redirects');
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Final-URL, X-Upstream-Status' };
function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { ...CORS, 'Content-Type': 'application/json' } }); }

async function handle(req, env) {
  const u = new URL(req.url), q = u.searchParams;
  if (req.method === 'OPTIONS') return new Response(null, { headers: { ...CORS, 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': '*' } });
  if (u.pathname === '/health') return json({ status: 'ok', type: RELAY_TYPE, features: ['socks5', 'socks4', 'http-connect', 'redirects'].concat(EXTRA_FEATURES), time: new Date().toISOString() });
  if (env.KEY && q.get('k') !== env.KEY) return json({ error: 'wrong or missing key' }, 403);
  try {
    if (u.pathname === '/test') {
      const proxy = { protocol: (q.get('proto') || 'http').toLowerCase().replace(/h$|a$/, ''), host: q.get('host'), port: +q.get('port') };
      const t0 = Date.now();
      try {
        const r = await withTimeout(fetchVia(proxy, IP_ECHO, 'en'), 9000, 'test');
        const ip = dec.decode(r.body).trim();
        if (r.status !== 200 || !/^[\d.:a-f]+$/i.test(ip)) return json({ status: 'dead', error: 'bad echo (' + r.status + ')' });
        return json({ status: 'alive', latency: Date.now() - t0, exitIp: ip });
      } catch (e) { return json({ status: 'dead', error: e.message }); }
    }
    if (u.pathname === '/fetch') {
      const url = q.get('url'); if (!/^https?:\/\//i.test(url || '')) return json({ error: 'url required' }, 400);
      const proxy = parseProxy(q.get('proxy'));
      const r = await withTimeout(fetchVia(proxy, url, q.get('lang') || 'ru,ar;q=0.9,en;q=0.8'), 25000, 'page');
      return new Response(r.body, { status: r.status >= 200 && r.status < 600 ? r.status : 502, headers: {
        ...CORS, 'Content-Type': r.headers['content-type'] || 'application/octet-stream',
        'X-Final-URL': r.finalUrl, 'X-Upstream-Status': String(r.status), 'Cache-Control': 'no-store' } });
    }
    return json({ error: 'unknown path', paths: ['/health', '/test', '/fetch'] }, 404);
  } catch (e) { return json({ error: e.message }, 502); }
}
export default { fetch: (req, env) => handle(req, env || {}) };
