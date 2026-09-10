// use the official socketio/chat-example checkout (cjs/step5), with its dependencies installed
const assert = require('node:assert/strict')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const fs = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join, resolve } = require('node:path')
const { setTimeout: delay } = require('node:timers/promises')
const hfsDir = resolve(process.env.HFS_DIR || join(__dirname, '../../../hfs'))
const chatDir = process.env.CHAT_DIR
assert.ok(chatDir, 'Set CHAT_DIR to an installed socketio/chat-example checkout (cjs/step5)')
const { chromium } = require(join(hfsDir, 'node_modules/@playwright/test'))
const processes = []
let browser, cwd

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
    await fs.mkdir(join(cwd, 'plugins'), { recursive: true })
    await fs.cp(resolve(__dirname, '../dist'), join(cwd, 'plugins/reverse-proxy'), { recursive: true })
    await fs.writeFile(join(cwd, 'config.yaml'), JSON.stringify({
        port: 0, listen_interface: '127.0.0.1', https_port: -1, open_browser_at_start: false,
        log: '', error_log: '', enable_plugins: ['reverse-proxy'],
        plugins_config: { 'reverse-proxy': { routes: [
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
    console.log('PASS: official Socket.IO chat through HFS; opt-in script URLs, unchanged default, real WebSockets, Unicode messages in both directions and page reload')
}

run().catch(error => { console.error(error); process.exitCode = 1 }).finally(async () => {
    if (browser) await browser.close()
    for (const { child, exited } of processes.reverse()) { child.kill(); await exited }
    if (cwd) await fs.rm(cwd, { recursive: true, force: true })
})
