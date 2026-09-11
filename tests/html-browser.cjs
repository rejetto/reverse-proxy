// use the official socketio/chat-example checkout (cjs/step5), with its dependencies installed
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs/promises')
const http = require('node:http')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const hfsDir = resolve(process.env.HFS_DIR || join(__dirname, '../../../hfs'))
const chatDir = process.env.CHAT_DIR
assert.ok(chatDir, 'Set CHAT_DIR to an installed socketio/chat-example checkout (cjs/step5)')
const { chromium } = require('playwright')
const processes = []
let browser, cwd, cssServer

async function start(args, directory, pattern) {
    const child = spawn(process.execPath, args, { cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] })
    const exited = once(child, 'exit')
    processes.push({ child, exited })
    let output = ''
    child.stdout.on('data', chunk => output += chunk)
    child.stderr.on('data', chunk => output += chunk)
    for (let i = 0; i < 100; i++) {
        const match = pattern.exec(output)
        if (match) return match[1]
        assert.equal(child.exitCode, null, output)
        await delay(100)
    }
    throw Error(output)
}

async function run() {
    cwd = await fs.mkdtemp(join(tmpdir(), 'hfs-html-browser-'))
    // retain the real app and its HTML; change only the listen address to isolate this test
    const entry = (await fs.readFile(join(chatDir, 'index.js'), 'utf8'))
        .replaceAll('__dirname', JSON.stringify(resolve(chatDir)))
        .replace(/server\.listen\([\s\S]*$/, `server.listen(0, '127.0.0.1', () => console.log('CHAT_PORT=' + server.address().port));`)
    const chatPort = await start(['-e', entry], chatDir, /CHAT_PORT=(\d+)/)
    const font = await fs.readFile(join(hfsDir, 'frontend/public/fontello.woff2'))
    cssServer = http.createServer((req, res) => {
        const name = new URL(req.url, 'http://upstream').pathname
        const files = {
            '/site/index.html': ['text/html', '<!doctype html><link rel="stylesheet" href="/site/main.css">'
                + '<style>.inline { background-image: url(/site/block.svg) }</style>'
                + '<div class="sample">&#xe800;</div><div class="inline">inline</div>'
                + '<div class="attribute" style="background-image: url(&quot;/site/attribute.svg&quot;)">attribute</div>'],
            '/site/main.css': ['text/css', '@import "/site/theme.css";'
                + '@font-face { font-family: ProxyTest; src: url(/site/font.woff2) }'
                + '.sample { font-family: ProxyTest; background-image: url(/site/image.svg) }'],
            '/site/theme.css': ['text/css', '.sample { color: rgb(12, 34, 56) }'],
            '/site/font.woff2': ['font/woff2', font],
        }
        const file = files[name] || name.endsWith('.svg') && ['image/svg+xml',
            '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="green"/></svg>']
        if (!file) { res.writeHead(404); res.end(); return }
        res.setHeader('content-type', file[0] + '; charset=utf-8')
        res.end(file[1])
    })
    cssServer.listen(0, '127.0.0.1')
    await once(cssServer, 'listening')
    await fs.mkdir(join(cwd, 'plugins'), { recursive: true })
    await fs.cp(resolve(__dirname, '../dist'), join(cwd, 'plugins/reverse-proxy'), { recursive: true })
    await fs.writeFile(join(cwd, 'config.yaml'), JSON.stringify({
        port: 0, listen_interface: '127.0.0.1', https_port: -1, open_browser_at_start: false,
        log: '', error_log: '', enable_plugins: ['reverse-proxy'],
        plugins_config: { 'reverse-proxy': { routes: [
            { path: '/design', url: `http://127.0.0.1:${cssServer.address().port}/site`, rewriteHtml: true },
            { path: '/adapted', url: `http://127.0.0.1:${chatPort}`, rewriteHtml: true },
            { path: '/plain', url: `http://127.0.0.1:${chatPort}` },
            // io() uses this root path in JavaScript; HTML rewriting deliberately does not change it
            { path: '/socket.io', url: `http://127.0.0.1:${chatPort}/socket.io` },
        ] } },
    }))
    const proxy = await start([join(hfsDir, 'dist/src/index.js'), '--cwd', cwd, '--no-central'], cwd,
        /Serving on (http:\/\/127\.0\.0\.1:\d+)/)
    for (let i = 0; i < 100; i++) {
        if ((await fetch(proxy + '/adapted/').then(r => r.text())).includes('Socket.IO chat')) break
        await delay(100)
    }
    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext()
    context.setDefaultTimeout(10000)
    const a = await context.newPage(), b = await context.newPage()
    const errors = [], scripts = [], sockets = []
    for (const page of [a, b]) {
        page.on('pageerror', error => errors.push(error.message))
        page.on('response', res => {
            if (res.url().endsWith('/socket.io.js')) scripts.push([res.url(), res.status()])
        })
        page.on('websocket', socket => sockets.push(socket.url()))
        await page.goto(proxy + '/adapted/')
        await page.waitForFunction(() => socket.connected && socket.io.engine.transport.name === 'websocket')
    }
    assert.deepEqual(scripts, Array(2).fill([proxy + '/adapted/socket.io/socket.io.js', 200]))
    for (const [sender, receiver, message] of [[a, b, 'Caffè e WebSocket ✓'], [b, a, 'Risposta 👋']]) {
        await sender.locator('#input').fill(message)
        await sender.getByRole('button', { name: 'Send' }).click()
        await receiver.getByText(message, { exact: true }).waitFor()
    }
    await b.reload()
    await b.waitForFunction(() => socket.connected && socket.io.engine.transport.name === 'websocket')
    await b.locator('#input').fill('Dopo reload')
    await b.getByRole('button', { name: 'Send' }).click()
    await a.getByText('Dopo reload', { exact: true }).waitFor()
    await b.goto(proxy + '/plain/')
    await b.waitForFunction(() => socket.connected)
    assert.deepEqual(scripts.at(-1), [proxy + '/socket.io/socket.io.js', 200])
    assert.ok(sockets.every(url => url.startsWith(proxy.replace('http:', 'ws:') + '/socket.io/')))
    assert.deepEqual(errors, [])
    const assets = []
    b.on('response', response => assets.push([new URL(response.url()).pathname, response.status()]))
    await b.goto(proxy + '/design/index.html')
    await b.waitForLoadState('networkidle')
    assert.equal(await b.locator('.sample').evaluate(el => getComputedStyle(el).color), 'rgb(12, 34, 56)')
    assert.equal(await b.evaluate(async () => (await document.fonts.load('16px ProxyTest', '\ue800')).length), 1)
    for (const name of ['main.css', 'theme.css', 'font.woff2', 'image.svg', 'block.svg', 'attribute.svg'])
        assert.ok(assets.some(([url, status]) => url === '/design/' + name && status === 200), name)
    for (const [selector, name] of [['.sample', 'image'], ['.inline', 'block'], ['.attribute', 'attribute']])
        assert.equal(await b.locator(selector).evaluate(el => getComputedStyle(el).backgroundImage),
            `url("${proxy}/design/${name}.svg")`)
    assert.deepEqual(errors, [])
    console.log('PASS: external stylesheet, @import, font, background images, style block and style attribute through HFS under /design')
    console.log('PASS: official Socket.IO chat through HFS; opt-in script URLs, unchanged default, real WebSockets, Unicode messages in both directions and page reload')
}

run().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
    if (browser) await browser.close()
    for (const { child, exited } of processes.reverse()) { child.kill(); await exited }
    if (cssServer) { cssServer.closeAllConnections(); cssServer.close() }
    if (cwd) await fs.rm(cwd, { recursive: true, force: true })
})
