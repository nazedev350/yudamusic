/*
  YudaMusic backend — perantara tipis antara index.html dan scraper ytmusic.js.
  - Browser tidak pernah memanggil YouTube Music langsung dan tidak pernah melihat API key.
  - Endpoint:  GET /api/search?q=...&type=songs|videos|albums|playlists|artists&limit=1..30
               GET /api/health
  - Juga menyajikan index.html di "/" agar frontend dan API satu origin (tanpa CORS).
  Hanya metadata. Server ini TIDAK menyediakan audio; pemutaran memakai YouTube IFrame Player API di browser.
*/
const http = require('http')
const fs = require('fs')
const path = require('path')

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
  const json = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(obj))
  }
  return http.createServer(async (req, res) => {
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
    if (u.pathname === '/api/health') return json(res, 200, { status: true, service: 'yudamusic', time: Date.now() })
    if (u.pathname !== '/api/search') return json(res, 404, { status: false, message: 'Not found' })

    // rate limit sederhana
    const ip = req.socket.remoteAddress || 'x'
    const now = Date.now()
    const h = hits.get(ip) || { n: 0, reset: now + 60000 }
    if (now > h.reset) { h.n = 0; h.reset = now + 60000 }
    h.n++; hits.set(ip, h)
    if (h.n > RATE_LIMIT) return json(res, 429, { status: false, message: 'Too many requests. Please wait a moment.' })

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
    if (c && now - c.t < CACHE_TTL) return json(res, 200, { ...c.v, cached: true })

    try {
      const raw = await searchFn(q, type, limit)
      const items = normalize(raw && raw.items, type).slice(0, limit)
      const v = { status: true, query: q, type, count: items.length, items }
      if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value)
      cache.set(key, { t: now, v })
      return json(res, 200, { ...v, cached: false })
    } catch (e) {
      // Struktur respons YouTube bisa berubah atau akses bisa gagal: laporkan apa adanya, jangan pura-pura sukses.
      console.error('[search error]', e && e.message)
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
