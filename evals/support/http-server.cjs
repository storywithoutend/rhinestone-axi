const fs = require('node:fs')
const http = require('node:http')

const mode = process.argv[2]
const portFile = process.argv[3]

const server = http.createServer((request, response) => {
  if (mode === 'status') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(
      JSON.stringify({
        status: 'QUEUED_BY_NEW_BACKEND',
        fillTransactionHash: '0xabc',
      }),
    )
    return
  }

  let body = ''
  request.on('data', (chunk) => {
    body += chunk
  })
  request.on('end', () => {
    const parsed = JSON.parse(body)
    const result = parsed.method === 'eth_chainId' ? '0xaa36a7' : '0x6000'
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id: parsed.id, result }))
  })
})

server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(portFile, String(server.address().port))
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
