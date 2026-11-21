/*
  soundcloud.js — SoundCloud fallback provider untuk YudaMusic.
  Diadaptasi dari SoundCloud.js (resolver ESM, credit: pembuat asli) menjadi CommonJS
  agar konsisten dengan ytmusic.js/server.js, dan ditambah fungsi search() karena
  resolver aslinya hanya resolve-by-URL.

  Dipakai sebagai fallback ketika YouTube menolak embed ("Embedding disabled by the
  video owner"): server mencari judul+artis yang sama di SoundCloud lalu mengembalikan
  metadata + URL stream progresif/HLS resminya (lewat endpoint publik SoundCloud,
  client_id publik yang sama dipakai situs soundcloud.com sendiri, bukan kredensial privat).
*/
const axios = require('axios')

const API = 'https://api-v2.soundcloud.com'
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const client = axios.create({
  timeout: 20000,
  headers: { 'User-Agent': UA, 'Accept': 'application/json' },
  validateStatus: s => s < 600
})

let cachedClientId = null
let cachedAt = 0
const CLIENT_ID_TTL = 60 * 60 * 1000 // 1 jam; client_id SoundCloud kadang berubah saat deploy mereka

async function fetchClientId() {
  if (cachedClientId && Date.now() - cachedAt < CLIENT_ID_TTL) return cachedClientId
  const page = await client.get('https://soundcloud.com/', { headers: { 'User-Agent': UA } })
  if (page.status >= 400 || typeof page.data !== 'string') throw new Error('Gagal membuka soundcloud.com')
  const scripts = [...page.data.matchAll(/<script[^>]+src="(https:\/\/[^"]+\.js)"/g)].map(m => m[1]).reverse()
  for (const src of scripts) {
    try {
      const js = await client.get(src, { headers: { 'User-Agent': UA } })
      if (typeof js.data !== 'string') continue
      const m = js.data.match(/client_id\s*:\s*"([0-9a-zA-Z]{32})"/)
      if (m) { cachedClientId = m[1]; cachedAt = Date.now(); return cachedClientId }
    } catch (_) { /* coba script berikutnya */ }
  }
  throw new Error('Gagal mengambil client_id dari SoundCloud')
}

async function api(path, params = {}) {
  const client_id = await fetchClientId()
  let full
  try { full = path.startsWith('http') ? new URL(path) : new URL(path, API) }
  catch (_) { throw new Error('Path API tidak valid') }
  full.searchParams.set('client_id', client_id)
  for (const [k, v] of Object.entries(params)) if (v != null) full.searchParams.set(k, String(v))
  const r = await client.get(full.toString(), { headers: { 'User-Agent': UA, Accept: 'application/json' } })
  if (r.status === 401) { cachedClientId = null; throw new Error('SoundCloud client_id expired') } // retry di panggilan berikutnya
  if (r.status >= 400) throw new Error('SoundCloud API ' + r.status)
  return r.data
}

async function resolveStream(transcoding) {
  if (!transcoding || !transcoding.url) return null
  try { const data = await api(transcoding.url); return (data && data.url) || null }
  catch (_) { return null }
}

function cleanArtwork(url) {
  if (!url || typeof url !== 'string') return null
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return null
    if (!/soundcloud|sndcdn/.test(u.hostname)) return null
    return url.replace('-large', '-t500x500')
  } catch (_) { return null }
}

async function formatTrack(track) {
  const trans = (track.media && track.media.transcodings) || []
  const progressive = trans.find(t => t.format && t.format.protocol === 'progressive' && t.format.mime_type && t.format.mime_type.includes('mpeg'))
  const hls = trans.find(t => t.format && t.format.protocol === 'hls' && t.format.mime_type && (t.format.mime_type.includes('mpeg') || t.format.mime_type.includes('mp4')))
  const [streamUrl, downloadUrl] = await Promise.all([resolveStream(hls || progressive), resolveStream(progressive || hls)])
  if (!streamUrl && !downloadUrl) return null // track tidak bisa diputar (private/geo-blocked/dihapus)
  return {
    provider: 'soundcloud',
    id: String(track.id),
    title: String(track.title || '').slice(0, 200),
    artist: String((track.user && (track.user.username || track.user.full_name)) || 'Unknown artist').slice(0, 150),
    durationSeconds: Math.round((track.duration || 0) / 1000),
    permalink: track.permalink_url || null,
    artwork: cleanArtwork(track.artwork_url || (track.user && track.user.avatar_url)),
    streamUrl: streamUrl || downloadUrl,
    playable: !!(streamUrl || downloadUrl)
  }
}

// Pencarian publik SoundCloud (tanpa akun/private API key — sama seperti yang dipakai
// widget pencarian resmi di soundcloud.com), dipakai untuk mencocokkan judul+artis
// ketika YouTube gagal memutar sebuah lagu.
async function search(query, limit = 5) {
  if (!query || !String(query).trim()) throw new Error('Query kosong')
  const q = String(query).trim().slice(0, 150)
  const data = await api('/search/tracks', { q, limit: Math.min(Math.max(limit, 1), 20) })
  const items = (data && Array.isArray(data.collection)) ? data.collection : []
  const tracks = []
  for (const t of items) {
    if (t && t.kind === 'track' && t.streamable !== false) {
      const formatted = await formatTrack(t).catch(() => null)
      if (formatted) tracks.push(formatted)
    }
  }
  return tracks
}

// Mencari kandidat terbaik untuk judul+artis tertentu (dipakai oleh fallback player).
// Skor sederhana: kecocokan kata pada judul dan nama artis, lebih berat ke judul.
function scoreCandidate(title, artist, cand) {
  const norm = s => String(s || '').toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim()
  const titleWords = new Set(norm(title).split(' ').filter(Boolean))
  const artistWords = new Set(norm(artist).split(' ').filter(Boolean))
  const candTitle = norm(cand.title), candArtist = norm(cand.artist)
  let score = 0
  titleWords.forEach(w => { if (w.length > 1 && candTitle.includes(w)) score += 2 })
  artistWords.forEach(w => { if (w.length > 1 && (candArtist.includes(w) || candTitle.includes(w))) score += 1 })
  return score
}

async function findBestMatch(title, artist) {
  const query = [title, artist].filter(Boolean).join(' ').trim()
  const candidates = await search(query, 8)
  if (!candidates.length) return null
  candidates.sort((a, b) => scoreCandidate(title, artist, b) - scoreCandidate(title, artist, a))
  return candidates[0]
}

module.exports = { search, findBestMatch, formatTrack, fetchClientId }
