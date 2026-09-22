const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { createHash, randomBytes } = require('node:crypto')
const { once } = require('node:events')
const { mkdtemp, mkdir, cp, writeFile, readFile, appendFile, rm } = require('node:fs/promises')
const { gzipSync } = require('node:zlib')
const http = require('node:http')
const { tmpdir } = require('node:os')
const { resolve, join } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const test = require('node:test')
const { WebSocket, WebSocketServer } = require('ws')

// run against a built HFS checkout: HFS_DIR=/path/to/hfs node --test tests/*.test.js
test('HFS reverse proxy integration', { timeout: 20000 }, async t => {
    const hfsDir = resolve(process.env.HFS_DIR || join(__dirname, '../../../hfs'))
    const cwd = await mkdtemp(join(tmpdir(), 'hfs-proxy-routing-'))
    const css = String.raw`@import "/chat-root/theme.css" layer(theme) screen;
/* url(/chat-root/comment.png) */
@font-face { font-family: Test; src: url('/chat-root/font.woff2') format('woff2') }
.test { background: url(\2f chat-root/image.svg?q=1#icon); --image: url(/chat-root/custom.png);
content: "url(/chat-root/text.png)"; mask: url(#mask); cursor: url(relative.cur), auto;
border-image: url(//example.com/image.png); list-style: url(data:image/png;base64,AA==) }
@namespace url(/chat-root/namespace);`
    const html = '<!doctype html><meta charset="utf-8"><a href="/chat-root/login?a=1&amp;b=2">Caffè</a>'
        + '<img src=/chat-root/image><script src="/chat-root/app.js"></script>'
        + '<script>const untouched = \'<a href="/chat-root/private">\';</script>'
        + '<!-- <img src="/chat-root/comment"> --><textarea><a href="/chat-root/text"></textarea>'
        + '<a href="//example.com/external">external</a><a href="/other">other mount</a>'
        + '<form action="/chat-root/receive"><button formaction="/chat-root/receive">Send</button></form>'
        + '<a href="relative">relative</a><div data-value="/chat-root/data"></div>'
        + '<a href="&#47;chat-root/entity">entity</a><a href="/chat-root/../outside">outside</a>'
        + '<a href="/\t/[invalid">invalid URL</a>'
    const upstream = http.createServer(async (req, res) => {
        const url = new URL(req.url, 'http://upstream')
        if (url.pathname.endsWith('/style.css')) {
            res.setHeader('content-type', 'text/css; charset=utf-8')
            res.setHeader('etag', '"css-original"')
            if (url.searchParams.has('no-transform')) res.setHeader('cache-control', 'no-transform')
            res.end(css)
        }
        else if (url.pathname.endsWith('/inline-css')) {
            res.setHeader('content-type', 'text/html; charset=utf-8')
            if (url.searchParams.has('csp')) res.setHeader('content-security-policy', "style-src 'sha256-example'")
            res.end('<style>.test { background: url(/chat-root/image.svg) }</style>'
                + '<div style="background: url(&quot;/chat-root/image.svg?q=1&amp;x=2&quot;)"></div>')
        }
        else if (url.pathname.endsWith('/html')) {
            let body = Buffer.from(html)
            res.setHeader('content-type', 'text/html; charset=utf-8')
            res.setHeader('etag', '"original"')
            res.setHeader('x-accepted-encoding', req.headers['accept-encoding'] || '')
            const mode = url.searchParams.get('mode')
            if (mode === 'large') body = Buffer.concat([body, Buffer.alloc(2 * 1024 * 1024, 32)])
            if (mode === 'gzip') {
                body = gzipSync(body)
                res.setHeader('content-encoding', 'gzip')
            }
            if (mode === 'charset') res.setHeader('content-type', 'text/html; charset=iso-8859-1')
            if (mode === 'json') res.setHeader('content-type', 'application/json')
            if (mode === 'no-transform') res.setHeader('cache-control', 'no-transform')
            if (mode === 'base') body = Buffer.from('<base href="https://example.com/">' + html)
            if (mode === 'chunked') body = Buffer.from('<!doctype html><p>No URL to rewrite</p>')
            if (mode === 'partial') res.statusCode = 206
            if (!['large', 'chunked'].includes(mode)) res.setHeader('content-length', body.length)
            // split attributes across chunks, and exercise overflow without Content-Length
            res.write(body.subarray(0, 65))
            res.end(body.subarray(65))
        }
        else if (url.pathname.endsWith('/redirect')) {
            res.writeHead(Number(url.searchParams.get('status') || 302), {
                location: url.searchParams.get('to'), 'set-cookie': 'redirect-test=1; Path=/',
            })
            res.end('redirect body')
        }
        else if (url.pathname.endsWith('/receive')) {
            const chunks = []
            for await (const chunk of req) chunks.push(chunk)
            res.end(JSON.stringify({ method: req.method, body: Buffer.concat(chunks).toString() }))
        }
        else
            res.end(req.url)
    })
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
    const wsHttp = http.createServer()
    const wsServer = new WebSocketServer({ server: wsHttp, path: '/socket' })
    wsServer.on('connection', socket => socket.on('message', data => socket.send(data)))
    wsHttp.listen(0, '127.0.0.1')
    await once(wsHttp, 'listening')
    t.after(() => {
        for (const socket of wsServer.clients) socket.terminate()
        wsServer.close()
        wsHttp.close()
    })
    const wsDest = `http://127.0.0.1:${wsHttp.address().port}`
    await mkdir(join(cwd, 'plugins/reverse-proxy'), { recursive: true })
    await cp(resolve(__dirname, '../dist'), join(cwd, 'plugins/reverse-proxy'), { recursive: true })
    await writeFile(join(cwd, 'config.yaml'), JSON.stringify({
        port: 0, listen_interface: '127.0.0.1', https_port: -1,
        open_browser_at_start: false, log: '', error_log: '',
        roots: { 'root.test': '/doc', 'nested.test': '/doc/nested', '*.wild.test': '//wild/' },
        enable_plugins: ['reverse-proxy'],
        server_code: `exports.init = api => {
            let server, updates = 0
            api.onServer(s => { if (s.listening) server = s })
            api.events.on('pluginUpdated', p => { if (p.id === 'reverse-proxy') updates++ })
            return { middleware(ctx) {
                if (ctx.path === '/_test/listeners') {
                    ctx.body = { count: server.listenerCount('upgrade'), updates }
                    ctx.stop()
                }
            } }
        }`,
        plugins_config: { 'reverse-proxy': { routes: [
            { path: '/fresh', host: 'root.test', url: dest },
            { path: '/doc/legacy', host: 'root.test', url: dest + '/chat-root', rewriteHtml: true },
            { path: '/doc/doc/repeat', host: 'root.test', url: dest },
            { path: '/doc', host: 'root.test', url: dest },
            { path: '/doc/shared', url: dest },
            { path: '/doc/nested/deep', url: dest },
            { path: '/documentary', url: dest },
            { path: '/doc/unrelated', host: 'unrelated.test', url: dest },
            { path: 'wild/app', host: 'app.wild.test', url: dest },
            { path: '/ws-app', url: wsDest },
            { path: '/ws-slash', url: wsDest + '/' },
            { path: '/site', url: dest },
            { path: '/adapted', url: dest + '/chat-root', rewriteHtml: true },
            { path: '/chat', host: 'other.test', url: dest + '/wrong-host' },
            { path: 'chat', url: dest + '/chat-root' },
            { path: '/chat-admin', url: dest + '/admin-root' },
            { path: '/trailing/', url: dest + '/trailing-root/' },
            { path: '/', host: 'proxy.test', url: dest + '/fallback/' },
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
    await t.test('HFS API and Admin remain reachable behind a catch-all route', async () => {
        for (const host of ['proxy.test', 'root.test']) {
            const session = await hostRequest('/~/api/refresh_session', host)
            assert.equal(JSON.parse(session.body).username, '')
            const admin = await hostRequest('/~/admin/', host)
            assert.match(admin.headers['content-type'], /text\/html/)
            assert.match(admin.body, /<!doctype html/i)
        }
        assert.equal((await hostRequest('/~other', 'proxy.test')).body, '/fallback/~other')
    })
    await t.test('HFS internal WebSocket paths are not forwarded by a catch-all route', async () => {
        await assert.rejects(upgrade('/~/api/refresh_session'), { code: 'ECONNRESET' })
    })
    await t.test('domain roots do not alter public proxy paths', async () => {
        assert.equal(await hostRequest('/fresh/ready?x=1').then(r => r.body), '/ready?x=1')
        assert.equal(await hostRequest('/legacy/ready').then(r => r.body), '/chat-root/ready')
        assert.equal(await upgrade('/legacy/ready', false, 'root.test'), '/chat-root/ready')
        const redirect = await hostRequest('/legacy/redirect?to=/chat-root/login')
        assert.equal(redirect.headers.location, '/legacy/login')
        assert.match((await hostRequest('/legacy/html')).body, /src="\/legacy\/app.js"/)
        assert.equal(await hostRequest('/ready').then(r => r.body), '/ready')
    })
    await t.test('existing paths are migrated once and persisted with their marker', async () => {
        const { config } = await control('get_plugin')
        assert.equal(config.pathsMigrationDone, true)
        assert.deepEqual(config.routes.slice(0, 9).map(r => r.path), [
            '/fresh', '/legacy', '/doc/repeat', '/', '/shared', '/deep',
            '/documentary', '/doc/unrelated', '/app',
        ])
        const routes = [...config.routes, { path: '/doc/new', host: 'root.test', url: dest }]
        await control('set_plugin', { config: { routes } })
        await control('stop_plugin')
        await control('start_plugin')
        assert.deepEqual((await control('get_plugin')).config.routes, routes)
        const yaml = require(require.resolve('yaml', { paths: [hfsDir] }))
        let saved
        for (let i = 0; i < 50; i++) {
            saved = yaml.parse(await readFile(join(cwd, 'config.yaml'), 'utf8')).plugins_config['reverse-proxy']
            if (saved.pathsMigrationDone && saved.routes.length === routes.length) break
            await delay(100)
        }
        assert.equal(saved.pathsMigrationDone, true)
        assert.deepEqual(saved.routes, routes)
    })
    await t.test('WebSocket messages reach a root-mounted server through a path prefix', async () => {
        await echo(wsDest + '/socket')
        for (const path of ['/ws-app/socket', '/ws-slash/socket'])
            await echo(proxy + path)

        async function echo(url) {
            const socket = new WebSocket(url.replace('http:', 'ws:'), { handshakeTimeout: 2000 })
            try {
                await once(socket, 'open')
                const reply = once(socket, 'message')
                socket.send('Caffè via WebSocket ✓')
                assert.equal(String((await reply)[0]), 'Caffè via WebSocket ✓')
            }
            finally {
                socket.terminate()
            }
        }
    })
    await t.test('CSS URLs and imports are opt-in, including inline styles', async () => {
        assert.equal(await fetch(proxy + '/chat/style.css').then(r => r.text()), css)
        const response = await fetch(proxy + '/adapted/style.css')
        assert.equal(await response.text(), css.replace('"/chat-root/theme.css"', '"/adapted/theme.css"')
            .replace("url('/chat-root/font.woff2')", 'url(/adapted/font.woff2)')
            .replace(String.raw`url(\2f chat-root/image.svg?q=1#icon)`, 'url(/adapted/image.svg?q=1#icon)')
            .replace('url(/chat-root/custom.png)', 'url(/adapted/custom.png)'))
        assert.equal(response.headers.get('etag'), null)
        assert.equal(await fetch(proxy + '/adapted/style.css?no-transform').then(r => r.text()), css)
        const inline = await fetch(proxy + '/adapted/inline-css').then(r => r.text())
        assert.equal(inline, '<style>.test { background: url(/adapted/image.svg) }</style>'
            + '<div style="background: url(/adapted/image.svg?q=1&amp;x=2)"></div>')
        assert.equal(await fetch(proxy + '/adapted/inline-css?csp').then(r => r.text()),
            await fetch(proxy + '/chat/inline-css?csp').then(r => r.text()))
    })
    await t.test('HTML rewriting is opt-in and preserves scripts, unrelated URLs and response metadata', async () => {
        const untouched = await fetch(proxy + '/chat/html')
        assert.equal(await untouched.text(), html)
        assert.equal(untouched.headers.get('etag'), '"original"')
        const response = await fetch(proxy + '/adapted/html')
        const body = await response.text()
        assert.equal(body, html.replace('href="/chat-root/login', 'href="/adapted/login')
            .replace('src=/chat-root/image', 'src="/adapted/image"')
            .replace('src="/chat-root/app.js', 'src="/adapted/app.js')
            .replaceAll('action="/chat-root/receive', 'action="/adapted/receive')
            .replace('href="&#47;chat-root/entity"', 'href="/adapted/entity"'))
        assert.equal(response.headers.get('etag'), null)
        assert.equal(Number(response.headers.get('content-length')), Buffer.byteLength(body))
        assert.equal(response.headers.get('x-accepted-encoding'), 'identity')
        for (const mode of ['large', 'gzip', 'charset', 'json', 'no-transform', 'base', 'partial', 'chunked']) {
            const res = await fetch(proxy + '/adapted/html?mode=' + mode)
            const expected = mode === 'large' ? html + ' '.repeat(2 * 1024 * 1024)
                : mode === 'base' ? '<base href="https://example.com/">' + html
                : mode === 'chunked' ? '<!doctype html><p>No URL to rewrite</p>' : html
            assert.equal(await res.text(), expected, mode)
            assert.equal(res.headers.get('etag'), '"original"', mode)
        }
    })
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

    await t.test('reload and disable remove only the proxy listener', async () => {
        const initial = await probe()
        for (let i = 0; i < 3; i++) {
            const before = await probe()
            await appendFile(join(cwd, 'plugins/reverse-proxy/plugin.js'), `\n// reload ${i}\n`)
            // pluginUpdated may precede the replacement plugin's async initialization
            for (let n = 0; n < 50; n++) {
                const current = await probe()
                if (current.updates > before.updates && current.count === initial.count) break
                await delay(100)
            }
            assert.ok((await probe()).updates > before.updates, 'HFS must actually reload the plugin')
            assert.equal((await probe()).count, initial.count)
            assert.equal(await upgrade('/chat/room'), '/chat-root/room')
            await control('stop_plugin')
            assert.equal((await probe()).count, initial.count - 1)
            await control('start_plugin')
            assert.equal((await probe()).count, initial.count)
            assert.equal(await upgrade('/chat/room'), '/chat-root/room')
        }
    })

    await t.test('root-relative redirects preserve the mount, status and response', async () => {
        for (const status of [301, 302, 303, 307, 308]) {
            const response = await fetch(proxy + '/chat/redirect?' + new URLSearchParams({
                status, to: '/chat-root/login?next=%2Fprivate#form',
            }), { redirect: 'manual' })
            assert.equal(response.status, status)
            assert.equal(response.headers.get('location'), '/chat/login?next=%2Fprivate#form')
            assert.match(response.headers.get('set-cookie'), /redirect-test=1/)
            assert.equal(await response.text(), 'redirect body')
        }
        for (const [mount, to, expected] of [
            ['/site', '/login', '/site/login'],
            ['/chat', '/chat-root?token=example', '/chat?token=example'],
            ['/chat', '/elsewhere', '/elsewhere'],
            ['/chat', '/chat-root-admin/login', '/chat-root-admin/login'],
            ['/chat', '//example.com/login', '//example.com/login'],
            ['/chat', 'https://example.com/login', 'https://example.com/login'],
            ['/chat', 'login', 'login'],
        ]) {
            const response = await fetch(proxy + mount + '/redirect?' + new URLSearchParams({ to }), { redirect: 'manual' })
            assert.equal(response.headers.get('location'), expected)
            await response.text()
        }
        const to = '/chat-root?token=example'
        assert.equal(await fetch(proxy + '/chat/redirect?' + new URLSearchParams({ to })).then(r => r.text()), to)
        for (const status of [307, 308]) {
            const response = await fetch(proxy + '/chat/redirect?' + new URLSearchParams({
                status, to: '/chat-root/receive',
            }), { method: 'POST', body: 'message to preserve', headers: { 'content-type': 'text/plain' } })
            assert.deepEqual(await response.json(), { method: 'POST', body: 'message to preserve' })
        }
    })

    function probe() {
        return fetch(proxy + '/_test/listeners').then(r => r.json())
    }

    async function control(action, params = {}) {
        const res = await fetch(proxy + '/~/api/' + action, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-hfs-anti-csrf': '1' },
            body: JSON.stringify({ id: 'reverse-proxy', ...params }),
        })
        const body = await res.text()
        assert.equal(res.status, 200, body)
        return JSON.parse(body)
    }

    async function hostRequest(path, host = 'root.test') {
        const req = http.get(proxy + path, { headers: { Host: host, 'x-hfs-anti-csrf': '1' } })
        const [res] = await once(req, 'response')
        const chunks = []
        for await (const chunk of res) chunks.push(chunk)
        return { headers: res.headers, body: Buffer.concat(chunks).toString() }
    }

    function upgrade(path, readBody = false, host = 'proxy.test') {
        return new Promise((resolve, reject) => {
            const req = http.get(proxy + path, { headers: {
                Host: host, Connection: 'Upgrade', Upgrade: 'websocket',
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
