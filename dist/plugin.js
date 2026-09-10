exports.version = 3
exports.apiRequired = 12.7 // 'onServer' event
exports.description = "With this plugin HFS becomes a proxy server"
exports.repo = "rejetto/reverse-proxy"
exports.preview = ["https://github.com/user-attachments/assets/9ab88fdc-bdab-43b5-8bab-bba1c6f6e396"]
exports.changelog = [
    { "version": 3, "message": "Add opt-in HTML URL rewriting for individual proxy routes" },
    { "version": 2.22, "message": "Fix WebSocket routing, fragmented handshakes and plugin reloads; preserve proxy paths and status in redirects" },
    { "version": 2.21, "message": "Handle upstream WebSocket connection errors" },
    { "version": 2.2, "message": "Option to validate upstream TLS certificates" },
    { "version": 2.1, "message": "Allow reordering of rules" },
    { "version": 2, "message": "Websocket support" },
    { "version": 1.21, "message": "Match routes by host" },
    { "version": 1.1, "message": "Better redirection support" }
]

exports.config = {
    routes: {
        helperText: "First rule matching applies (top to bottom)",
        type: 'array', reorder: true, defaultValue: [], width: { xs: 'auto', sm: 600, md: 800 },
        fields: {
            path: { label: 'Source path', $width: 1, placeholder: '/website', $mergeRender: { host: {} } },
            host: { label: 'Source host', $width: 1, placeholder: "leave empty for any", $hideUnder: 'sm' },
            url: { label: 'Destination URL', $width: 2, placeholder: 'http://example.com' },
            rewriteHtml: { type: 'boolean', defaultValue: false, label: "Rewrite HTML URLs",
                helperText: "Adapt root-relative HTML links to the source path. Does not rewrite JavaScript or CSS." }
        }
    },
    rejectUnauthorized: { type: 'boolean', defaultValue: false, label: "Validate upstream TLS certificates" },
}

exports.init = async api => {
    // TODO: delegate listener cleanup to api.onServer when apiRequired can be raised to 13.4
    const upgradeHandlers = new Map()
    await api.onServer(handleWebsockets)
    return {
        unload() {
            // onServer subscriptions are managed by HFS, but direct server listeners are not
            for (const [server, handler] of upgradeHandlers)
                server.removeListener('upgrade', handler)
            upgradeHandlers.clear()
        },
        async middleware(ctx) {
            for (const route of api.getConfig('routes')) {
                let { path = '', host, url } = route
                if (host && ctx.host !== host) continue
                if (!path.startsWith('/'))
                    path = '/' + path
                if (!ctx.path.startsWith(path)) continue
                if (path.length > 1 && ctx.path.length > path.length && ctx.path[path.length] !== '/') continue
                if (url.endsWith('/'))
                    url = url.slice(0, -1)
                const dest = url + ctx.url.slice(path.length === 1 ? 0 : path.length)
                try {
                    const parsed = api.require('url').parse(dest)
                    const forward = {
                        url: dest,
                        method: ctx.method,
                        headers: {
                            ...ctx.headers,
                            host: parsed.host,
                            'X-Forwarded-For': ctx.ip,
                            'X-Forwarded-Proto': ctx.protocol,
                            'X-Forwarded-Host': ctx.host,
                        },
                        body: ctx.req,
                        httpThrow: false,
                        rejectUnauthorized: api.getConfig('rejectUnauthorized'),
                        noRedirect: true, // redirect must be handled differently
                    }
                    if (route.rewriteHtml)
                        forward.headers['accept-encoding'] = 'identity'
                    await Promise.all(api.customApiCall('reverseproxy_forward', { ctx, forward })) // allow plugins to interact
                    const { url } = forward
                    forward.url = undefined // dont' delete, for performance reasons
                    const req = await api.require('./misc').httpStream(url, forward)
                    const location = req.headers.location
                    if (location?.startsWith(url))
                        req.headers.location = path + location.slice(url.length)
                    else if (location?.startsWith('/') && !location.startsWith('//')) {
                        const basePath = new URL(route.url).pathname.replace(/\/$/, '')
                        const target = new URL(location, url)
                        // only paths inside the upstream mount can be reached through this route
                        if (target.pathname === basePath || target.pathname.startsWith(basePath + '/'))
                            req.headers.location = (path.replace(/\/$/, '') + target.pathname.slice(basePath.length) || '/')
                                + target.search + target.hash
                    }
                    const body = route.rewriteHtml && ctx.method !== 'HEAD'
                        ? await require('./rewrite-html')(req, path, route.url) : req
                    ctx.status = req.statusCode
                    ctx.set(req.headers)
                    ctx.body = body
                } catch (e) {
                    ctx.status = 502
                    ctx.body = String(e)
                }
                return
            }
        },
    }

    function handleWebsockets(server) {
        // onServer can report the same server again when it resumes listening
        if (upgradeHandlers.has(server)) return
        const handler = (req, clientSocket) => {
            const key = req.headers['sec-websocket-key']
            if (!key || req.headers.upgrade !== 'websocket' || !req.headers.connection?.includes('Upgrade')) return
            const pathname = req.url.split('?')[0]
            for (const route of api.getConfig('routes')) {
                let { path = '', host, url } = route
                if (host && req.headers.host !== host) continue
                if (!path.startsWith('/'))
                    path = '/' + path
                if (!pathname.startsWith(path)) continue
                if (!path.endsWith('/') && pathname.length > path.length && pathname[path.length] !== '/') continue
                const parsedUrl = new URL(url)
                const targetHost = parsedUrl.hostname
                const targetPort = parseInt(parsedUrl.port) || parsedUrl.protocol === 'https:' && 443 || 80
                const targetPath = parsedUrl.pathname + req.url.slice(path.length)
                const outgoingHeaders = Object.entries({
                    ...req.headers,
                    host: targetHost + (targetPort ? `:${targetPort}` : ''),
                    'X-Forwarded-For': req.socket.remoteAddress,
                    'X-Forwarded-Proto': req.socket.encrypted ? 'https' : 'http',
                    'X-Forwarded-Host': req.headers.host,
                }).map(([key, value]) => `${key}: ${value}`).join('\r\n')
                const serverSocket = api.require(parsedUrl.protocol === 'https:' ? 'tls' : 'net').connect({
                    host: targetHost,
                    port: targetPort,
                    ...parsedUrl.protocol === 'https:' && { rejectUnauthorized: api.getConfig('rejectUnauthorized') }
                })
                serverSocket.on('connect', () => {
                    serverSocket.write(`${req.method} ${targetPath} HTTP/1.1\r\n${outgoingHeaders}\r\n\r\n`)
                })
                let response = Buffer.alloc(0)
                serverSocket.on('data', handleHandshake)
                function handleHandshake(data) {
                    response = Buffer.concat([response, data])
                    const end = response.indexOf('\r\n\r\n')
                    // bound buffering while waiting for a complete upstream handshake
                    if ((end < 0 ? response.length : end) > api.require('http').maxHeaderSize) {
                        clientSocket.destroy()
                        serverSocket.destroy()
                        return
                    }
                    if (end < 0) return
                    const header = response.subarray(0, end).toString('latin1')
                    if (!/^HTTP\/1\.[01] 101 /.test(header)) {
                        clientSocket.destroy()
                        serverSocket.destroy()
                        return
                    }
                    serverSocket.removeListener('data', handleHandshake)
                    const accept = api.require('crypto').createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') // magic string (RFC 6455)
                    clientSocket.write(header.replace(/^(Sec-WebSocket-Accept:\s+).+$/im, '$1' + accept) + '\r\n\r\n', 'latin1')
                    // a frame can arrive with the headers and must retain its original bytes
                    clientSocket.write(response.subarray(end + 4))
                    clientSocket.upgraded = true
                    clientSocket.pipe(serverSocket).pipe(clientSocket)
                }
                serverSocket.on('timeout', () => {
                    clientSocket.destroy()
                    serverSocket.destroy()
                })
                serverSocket.on('error', () => clientSocket.destroy())
                clientSocket.on('error', () => serverSocket.destroy())
                serverSocket.on('end', () => clientSocket.end())
                serverSocket.on('close', () => clientSocket.end())
                return
            }
            clientSocket.destroy() // no route found
        }
        upgradeHandlers.set(server, handler)
        server.on('upgrade', handler)
    }

}
