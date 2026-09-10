const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { createHash, randomBytes } = require('node:crypto')
const { once } = require('node:events')
const { mkdtemp, mkdir, copyFile, writeFile, rm } = require('node:fs/promises')
const http = require('node:http')
const { tmpdir } = require('node:os')
const { resolve, join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const test = require('node:test')

// run against a built HFS checkout: HFS_DIR=/path/to/hfs node --test tests/*.test.js
test('HFS routes real WebSocket upgrades by complete path prefix', { timeout: 20000 }, async t => {
    const hfsDir = resolve(process.env.HFS_DIR || join(__dirname, '../../../hfs'))
    const cwd = await mkdtemp(join(tmpdir(), 'hfs-proxy-routing-'))
    const upstream = http.createServer((req, res) => res.end(req.url))
    const sockets = new Set()
    upstream.on('connection', socket => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
    })
    const binaryFrame = Buffer.from([0x82, 5, 0, 128, 255, 195, 169])
    upstream.on('upgrade', (req, socket) => {
        const accept = createHash('sha1').update(req.headers['sec-websocket-key']
            + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64')
        const header = 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
            + `Sec-WebSocket-Accept: ${accept}\r\nX-Upstream-Path: ${req.url}\r\n\r\n`
        if (req.url.endsWith('/fragmented')) {
            socket.write(header.slice(0, 8))
            setTimeout(() => socket.end(Buffer.concat([Buffer.from(header.slice(8)), binaryFrame])), 30)
        }
        else if (req.url.endsWith('/binary'))
            socket.end(Buffer.concat([Buffer.from(header), binaryFrame]))
        else
            socket.end(header)
    })
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    t.after(() => {
        for (const socket of sockets) socket.destroy()
        upstream.close()
    })
    const dest = `http://127.0.0.1:${upstream.address().port}`
    await mkdir(join(cwd, 'plugins/reverse-proxy'), { recursive: true })
    await copyFile(resolve(__dirname, '../dist/plugin.js'), join(cwd, 'plugins/reverse-proxy/plugin.js'))
    await writeFile(join(cwd, 'config.yaml'), JSON.stringify({
        port: 0, listen_interface: '127.0.0.1', https_port: -1,
        open_browser_at_start: false, log: '', error_log: '',
        enable_plugins: ['reverse-proxy'],
        plugins_config: { 'reverse-proxy': { routes: [
            { path: '/chat', host: 'other.test', url: dest + '/wrong-host' },
            { path: 'chat', url: dest + '/chat-root' },
            { path: '/chat-admin', url: dest + '/admin-root' },
            { path: '/trailing/', url: dest + '/trailing-root/' },
            { path: '/', url: dest + '/fallback/' },
        ] } },
    }))
    const hfs = spawn(process.execPath, [join(hfsDir, 'dist/src/index.js'), '--cwd', cwd, '--no-central'], {
        stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stopped = once(hfs, 'exit')
    t.after(async () => {
        hfs.kill()
        await stopped
        await rm(cwd, { recursive: true, force: true })
    })
    let output = ''
    hfs.stdout.on('data', chunk => output += chunk)
    hfs.stderr.on('data', chunk => output += chunk)
    let proxy
    // HFS starts listening and loads plugins asynchronously; wait for an actual forwarded response
    for (let i = 0; i < 100; i++) {
        proxy = /Serving on (http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1]
        if (proxy && await fetch(proxy + '/chat/ready').then(r => r.text()).catch(() => '') === '/chat-root/ready')
            break
        assert.equal(hfs.exitCode, null, output)
        await delay(100)
    }
    assert.ok(proxy, output)
    assert.equal(await fetch(proxy + '/chat/ready').then(r => r.text()), '/chat-root/ready', output)
    for (const [path, expected] of [
        ['/chat', '/chat-root'],
        ['/chat?token=example', '/chat-root?token=example'],
        ['/chat/room?token=example', '/chat-root/room?token=example'],
        ['/chat-admin', '/admin-root'],
        ['/chat-admin/room?token=example', '/admin-root/room?token=example'],
        ['/chatty', '/fallback/chatty'],
        ['/chat%2Dadmin', '/fallback/chat%2Dadmin'],
        ['/trailing/room?token=example', '/trailing-root/room?token=example'],
        ['/?token=example', '/fallback/?token=example'],
    ]) {
        await t.test(path, async () => assert.equal(await upgrade(path), expected))
    }

    for (const path of ['/chat/fragmented', '/chat/binary']) {
        await t.test(path, async () => assert.deepEqual(await upgrade(path, true), binaryFrame))
    }

    function upgrade(path, readBody = false) {
        return new Promise((resolve, reject) => {
            const req = http.get(proxy + path, { headers: {
                Connection: 'Upgrade', Upgrade: 'websocket',
                'Sec-WebSocket-Key': randomBytes(16).toString('base64'), 'Sec-WebSocket-Version': '13',
            } })
            req.on('upgrade', (res, socket, head) => {
                if (readBody) {
                    const chunks = [head]
                    socket.on('data', chunk => chunks.push(chunk))
                    socket.on('end', () => resolve(Buffer.concat(chunks)))
                    socket.on('error', reject)
                    socket.setTimeout(3000, () => socket.destroy(Error('WebSocket data timed out')))
                }
                else {
                    socket.destroy()
                    resolve(res.headers['x-upstream-path'])
                }
            })
            req.on('response', res => {
                res.resume()
                reject(Error(`Expected upgrade, received ${res.statusCode}`))
            })
            req.on('error', reject)
            req.setTimeout(3000, () => req.destroy(Error('WebSocket upgrade timed out')))
        })
    }
})
