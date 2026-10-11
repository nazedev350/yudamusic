// Adapter Vercel (tanpa folder). Jika gagal dimuat, pesan error ditampilkan di halaman
// supaya penyebab 500 terlihat langsung (tanpa harus buka log Vercel).
let server, loadError

try {
  const { createServer } = require('./server')
  const { search } = require('./ytmusic')
  server = createServer(search)
} catch (e) {
  loadError = e
}

module.exports = (req, res) => {
  if (loadError) {
    res.statusCode = 500
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    return res.end(JSON.stringify({
      status: false,
      message: 'Gagal memuat server',
      error: String(loadError && loadError.message),
      stack: String(loadError && loadError.stack).split('\n').slice(0, 6)
    }, null, 2))
  }
  return server.emit('request', req, res)
}
