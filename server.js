/*
  YudaMusic backend — perantara tipis antara index.html dan scraper ytmusic.js.
  - Browser tidak pernah memanggil YouTube Music langsung dan tidak pernah melihat API key.
  - Endpoint:  GET /api/search?q=...&type=songs|videos|albums|playlists|artists&limit=1..30
               GET /api/health
               GET /api/stats      (statistik server untuk dashboard; dilindungi STATS_TOKEN jika di-set)
               GET /dashboard      (dashboard.html)
  - Juga menyajikan index.html di "/" agar frontend dan API satu origin (tanpa CORS).
  Hanya metadata. Server ini TIDAK menyediakan audio; pemutaran memakai YouTube IFrame Player API di browser.
*/
const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const TYPES = ['songs', 'videos', 'albums', 'playlists', 'artists']
const CACHE_TTL = 10 * 60 * 1000
const CACHE_MAX = 200
const RATE_LIMIT = 30          // permintaan per menit per IP
const MAX_LIMIT = 30
const IMG_HOSTS = ['ytimg.com', 'googleusercontent.com', 'ggpht.com']

function safeImg(u) {
  try {
    const x = new URL(u)
    if (x.protocol !== 'https:') return null
    return IMG_HOSTS.some(h => x.hostname === h || x.hostname.endsWith('.' + h)) ? x.href : null
  } catch (_) { return null }
}
function parseDuration(s) {
  if (!s || !/^\d+(:\d{1,2}){1,2}$/.test(s)) return 0
  return s.split(':').map(Number).reduce((a, n) => a * 60 + n, 0)
}
// Mengubah objek mentah scraper menjadi bentuk yang stabil untuk frontend.
function normalize(items, type) {
  const out = []
  for (const it of Array.isArray(items) ? items : []) {
    if (!it || typeof it !== 'object' || !it.title) continue
    const t = String(it.type || '')
    let kind = null
    if (/ARTIST/.test(t)) kind = 'artist'
    else if (/ALBUM/.test(t)) kind = 'album'
    else if (/PLAYLIST/.test(t)) kind = 'playlist'
    else if (it.videoId && /^[\w-]{11}$/.test(it.videoId)) kind = type === 'videos' ? 'video' : 'song'
    else if (type === 'artists' || type === 'albums' || type === 'playlists') kind = type.slice(0, -1)
    if (!kind) continue
    const playable = kind === 'song' || kind === 'video'
    const videoId = playable && /^[\w-]{11}$/.test(it.videoId || '') ? it.videoId : null
    const browseId = !playable && it.browseId ? String(it.browseId) : null
    if (playable && !videoId) continue
    if (!playable && !browseId) continue
    out.push({
      kind, videoId, browseId,
      title: String(it.title).slice(0, 200),
      artists: Array.isArray(it.artists) ? it.artists.map(a => String(a).slice(0, 100)) : [],
      album: it.album ? String(it.album).slice(0, 200) : null,
      duration: it.duration || null,
      durationSeconds: parseDuration(it.duration),
      plays: it.plays || null,
      thumbnail: safeImg(it.thumbnail)
    })
  }
  return out
}

function createServer(searchFn, opts = {}) {
  const cache = new Map()
  const hits = new Map()
  const indexPath = opts.indexPath || path.join(__dirname, 'index.html')
  const dashboardPath = opts.dashboardPath || path.join(__dirname, 'dashboard.html')
  // Statistik ringan di memori untuk dashboard. Tidak menyimpan IP, query, atau data pengguna.
  const startedAt = Date.now()
  const stats = { requests: 0, byRoute: {}, byStatus: {}, rateLimited: 0, cacheHits: 0, cacheMisses: 0, searchOk: 0, searchFail: 0, searchMs: [], lastError: null }
  const KNOWN = ['/', '/dashboard', '/api/health', '/api/stats', '/api/search']
  const statsAllowed = req => {
    const want = process.env.STATS_TOKEN
    if (!want) return true
    const got = String(req.headers['x-stats-token'] || '')
    const a = crypto.createHash('sha256').update(got).digest(), b = crypto.createHash('sha256').update(want).digest()
    return crypto.timingSafeEqual(a, b)
  }
  const pct = (arr, p) => { if (!arr.length) return null; const x = [...arr].sort((m, n) => m - n); return x[Math.min(x.length - 1, Math.ceil(p * x.length) - 1)] }
  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(obj))
  }
  return http.createServer(async (req, res) => {
    stats.requests++
    res.on('finish', () => { const c = Math.floor(res.statusCode / 100) + 'xx'; stats.byStatus[c] = (stats.byStatus[c] || 0) + 1 })
    let u
    try { u = new URL(req.url, 'http://localhost') } catch (_) { return json(res, 400, { status: false, message: 'Bad request' }) }
    if (req.method !== 'GET') return json(res, 405, { status: false, message: 'Method not allowed' })

    if (u.pathname === '/' || u.pathname === '/index.html') {
      try {
        const html = fs.readFileSync(indexPath)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        return res.end(html)
      } catch (_) { return json(res, 500, { status: false, message: 'index.html not found' }) }
    }
    {
      const k = u.pathname === '/index.html' ? '/' : u.pathname === '/dashboard.html' ? '/dashboard' : u.pathname
      const rk = KNOWN.includes(k) ? k : 'other'
      stats.byRoute[rk] = (stats.byRoute[rk] || 0) + 1
    }
    if (u.pathname === '/dashboard' || u.pathname === '/dashboard.html') {
      try {
        const html = fs.readFileSync(dashboardPath)
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
        return res.end(html)
      } catch (_) { return json(res, 500, { status: false, message: 'dashboard.html not found' }) }
    }
    if (u.pathname === '/api/stats') {
      if (!statsAllowed(req)) return json(res, 401, { status: false, message: 'Stats token required.' })
      const m = process.memoryUsage(), tot = stats.cacheHits + stats.cacheMisses
      return json(res, 200, {
        status: true, service: 'yudamusic', time: Date.now(), startedAt, uptimeMs: Date.now() - startedAt,
        runtime: { node: process.version, platform: process.env.VERCEL ? 'vercel (serverless)' : 'node', protected: !!process.env.STATS_TOKEN },
        memory: { rss: m.rss, heapUsed: m.heapUsed, heapTotal: m.heapTotal },
        requests: { total: stats.requests, byRoute: stats.byRoute, byStatus: stats.byStatus },
        rateLimit: { limitPerMinute: RATE_LIMIT, blocked: stats.rateLimited, trackedClients: hits.size },
        cache: { size: cache.size, max: CACHE_MAX, ttlSeconds: CACHE_TTL / 1000, hits: stats.cacheHits, misses: stats.cacheMisses, hitRate: tot ? stats.cacheHits / tot : null },
        search: { ok: stats.searchOk, failed: stats.searchFail, avgMs: stats.searchMs.length ? Math.round(stats.searchMs.reduce((a, n) => a + n, 0) / stats.searchMs.length) : null, p95Ms: pct(stats.searchMs, 0.95), lastError: stats.lastError }
      })
    }
    if (u.pathname === '/api/health') return json(res, 200, { status: true, service: 'yudamusic', time: Date.now() })
    if (u.pathname !== '/api/search') return json(res, 404, { status: false, message: 'Not found' })

    // rate limit sederhana
    const ip = req.socket.remoteAddress || 'x'
    const now = Date.now()
    const h = hits.get(ip) || { n: 0, reset: now + 60000 }
    if (now > h.reset) { h.n = 0; h.reset = now + 60000 }
    h.n++; hits.set(ip, h)
    if (h.n > RATE_LIMIT) { stats.rateLimited++; return json(res, 429, { status: false, message: 'Too many requests. Please wait a moment.' }) }

    // validasi input
    const q = (u.searchParams.get('q') || '').replace(/\s+/g, ' ').trim()
    const type = u.searchParams.get('type') || 'songs'
    let limit = parseInt(u.searchParams.get('limit') || '20', 10)
    if (!q || q.length < 2 || q.length > 100) return json(res, 400, { status: false, message: 'Query must be 2-100 characters.' })
    if (!TYPES.includes(type)) return json(res, 400, { status: false, message: 'Invalid type. Use: ' + TYPES.join(', ') })
    if (!Number.isFinite(limit) || limit < 1) limit = 20
    limit = Math.min(limit, MAX_LIMIT)

    const key = type + '|' + limit + '|' + q.toLowerCase()
    const c = cache.get(key)
    if (c && now - c.t < CACHE_TTL) { stats.cacheHits++; return json(res, 200, { ...c.v, cached: true }) }
    stats.cacheMisses++

    const t0 = Date.now()
    try {
      const raw = await searchFn(q, type, limit)
      const items = normalize(raw && raw.items, type).slice(0, limit)
      const v = { status: true, query: q, type, count: items.length, items }
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
      cache.set(key, { t: now, v })
      stats.searchOk++; stats.searchMs.push(Date.now() - t0); if (stats.searchMs.length > 50) stats.searchMs.shift()
      return json(res, 200, { ...v, cached: false })
    } catch (e) {
      // Struktur respons YouTube bisa berubah atau akses bisa gagal: laporkan apa adanya, jangan pura-pura sukses.
      console.error('[search error]', e && e.message)
      stats.searchFail++; stats.lastError = { message: String(e && e.message || 'unknown error').slice(0, 160), time: Date.now() }
      return json(res, 502, { status: false, message: 'Search source failed: ' + String(e && e.message || 'unknown error').slice(0, 160) })
    }
  })
}

module.exports = { createServer, normalize, parseDuration, safeImg }

if (require.main === module) {
  const { search } = require('./ytmusic')
  const port = Number(process.env.PORT) || 3000
  createServer(search).listen(port, () => console.log('YudaMusic running on http://localhost:' + port))
}
