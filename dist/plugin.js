exports.version = 4.01
exports.apiRequired = 13.4 // api.onServer cleanup
exports.description = "With this plugin HFS becomes a proxy server"
exports.repo = "rejetto/reverse-proxy"
exports.preview = ["https://github.com/user-attachments/assets/9ab88fdc-bdab-43b5-8bab-bba1c6f6e396"]
exports.changelog = [
    { "version": 4.01, "message": "Avoid warning `url.parse` in console" },
    { "version": 4, "message": "Protect routes with accounts and groups" },
    { "version": 3.13, "message": "Keep HFS login, APIs and interface assets accessible with catch-all proxy routes" },
    { "version": 3.12, "message": "Fix proxy routing with domain roots" },
    { "version": 3.11, "message": "Fix WebSocket connection failures caused by duplicate slashes when joining proxy paths" },
    { "version": 3.1, "message": "Extend opt-in URL rewriting to CSS stylesheets, imports and inline styles" },
    { "version": 3, "message": "Add opt-in HTML URL rewriting for individual proxy routes" },
    { "version": 2.22, "message": "Fix WebSocket routing, fragmented handshakes and plugin reloads; preserve proxy paths and status in redirects" },
    { "version": 2.21, "message": "Handle upstream WebSocket connection errors" },
    { "version": 2.2, "message": "Option to validate upstream TLS certificates" },
    { "version": 2.1, "message": "Allow reordering of rules" },
    { "version": 2, "message": "Websocket support" },
    { "version": 1.21, "message": "Match routes by host" },
    { "version": 1.1, "message": "Better redirection support" }
]

exports.configDialog = { maxWidth: 'lg' }
exports.frontend_js = "login.js"
exports.config = {
    routes: {
        helperText: "First rule matching applies (top to bottom)",
        type: 'array', reorder: true, defaultValue: [], width: { xs: 'auto', sm: 600, md: 800 },
        fields: {
            path: { label: 'Source path', $width: 1, placeholder: '/website', $mergeRender: { host: {} } },
            host: { label: 'Source host', $width: 1, placeholder: "leave empty for any", $hideUnder: true },
            url: { label: 'Destination URL', $width: 2, placeholder: 'http://example.com' },
            // keep the original key so existing route settings carry over
            rewriteHtml: { type: 'boolean', defaultValue: false, label: "Rewrite HTML/CSS URLs",
                $width: .4, $column: { headerName: "Rewrite URLs" },
                helperText: "Adapt root-relative HTML and CSS URLs to the source path. Does not rewrite JavaScript." },
            accounts: { type: 'username', multiple: true, label: "Allowed accounts", $width: 1, $column: { headerName: "Accounts" },
                helperText: "Allow only these HFS accounts or their group members. Leave empty for public access." }
        }
    },
    rejectUnauthorized: { type: 'boolean', defaultValue: false, label: "Validate upstream TLS certificates" },
}

exports.init = async api => {
    migratePaths()
    const upgradeServers = new Set()
    let serveLogin
    await api.onServer(handleWebsockets)
    return {
        async middleware(ctx) {
            const requestPath = ctx.state.originalPath
            // HFS needs its internal URLs for login, APIs and interface assets even with a catch-all route
            if (requestPath.startsWith('/~/')) return
            for (const route of api.getConfig('routes')) {
                let { path = '', host, url } = route
                if (host && ctx.host !== host) continue
                if (!path.startsWith('/'))
                    path = '/' + path
                if (!requestPath.startsWith(path)) continue
                if (path.length > 1 && requestPath.length > path.length && requestPath[path.length] !== '/') continue
                const denied = accessStatus(route, ctx)
                if (denied) {
                    ctx.stop()
                    ctx.status = denied
                    ctx.body = denied === 401 ? "Unauthorized" : "Forbidden"
                    ctx.set('Cache-Control', 'no-store')
                    if (ctx.method === 'GET' && ctx.get('accept').includes('text/html')) {
                        serveLogin ||= api.require('./serveGuiFiles').serveGuiFiles(undefined, '/~/frontend/')
                        ctx.state.serveApp = true
                        await serveLogin(ctx)
                        ctx.body = ctx.body.replace('</head>', '<meta name="hfs-proxy-login" content="1"></head>')
                        ctx.status = denied
                    }
                    return
                }
                if (url.endsWith('/'))
                    url = url.slice(0, -1)
                const dest = url + ctx.originalUrl.slice(path.length === 1 ? 0 : path.length)
                try {
                    const parsed = new URL(dest)
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

    function accessStatus(route, ctx) {
        return !route.accounts?.length || api.ctxBelongsTo(ctx, route.accounts) ? 0 : ctx.state.account ? 403 : 401
    }

    async function authenticateUpgrade(req) {
        const { app } = api.require('./index')
        const { sessionMiddleware, prepareState, someSecurity } = api.require('./middlewares')
        const res = new (api.require('http').ServerResponse)(req)
        const ctx = app.createContext(req, res)
        let accepted = false
        // upgrades bypass Koa; reuse HFS checks instead of independently interpreting credentials or session cookies
        await sessionMiddleware(ctx, () => prepareState(ctx, () => someSecurity(ctx, async () => { accepted = true })))
        return { ctx, accepted, cookies: res.getHeader('set-cookie') || [] }
    }

    function migratePaths() {
        if (api.getConfig('pathsMigrationDone')) return
        const { makeMatcher } = api.require('./misc')
        const roots = Object.entries(api.getHfsConfig('roots')).map(([host, path]) => ({
            matches: makeMatcher(host), path: '/' + path.split('/').filter(Boolean).join('/'),
        }))
        const routes = api.getConfig('routes').map(route => {
            const path = (route.path || '').startsWith('/') ? route.path : '/' + (route.path || '')
            const candidates = route.host ? roots.filter(root => root.matches(route.host)).slice(0, 1) : roots
            // ponytail: infer legacy prefixes from configured roots; use explicit mapping if this heuristic becomes insufficient
            const root = candidates.filter(root => root.path !== '/'
                && (path === root.path || path.startsWith(root.path + '/')))
                .sort((a, b) => b.path.length - a.path.length)[0]
            return root ? { ...route, path: path.slice(root.path.length) || '/' } : route
        })
        api.setConfig('routes', routes)
        // persist even with no roots, so later configuration changes cannot trigger another conversion
        api.setConfig('pathsMigrationDone', true)
    }

    function handleWebsockets(server) {
        // onServer can report the same server again when it resumes listening
        if (upgradeServers.has(server)) return
        const handler = async (req, clientSocket) => {
            const key = req.headers['sec-websocket-key']
            if (!key || req.headers.upgrade !== 'websocket' || !req.headers.connection?.includes('Upgrade')) return
            const pathname = req.url.split('?')[0]
            if (pathname.startsWith('/~/')) {
                clientSocket.destroy()
                return
            }
            for (const route of api.getConfig('routes')) {
                let { path = '', host, url } = route
                if (host && req.headers.host !== host) continue
                if (!path.startsWith('/'))
                    path = '/' + path
                if (!pathname.startsWith(path)) continue
                if (!path.endsWith('/') && pathname.length > path.length && pathname[path.length] !== '/') continue
                let cookies = []
                if (route.accounts?.length) {
                    let denied = 401
                    try {
                        const auth = await authenticateUpgrade(req)
                        cookies = auth.cookies
                        denied = auth.accepted ? accessStatus(route, auth.ctx) : 401
                        // browsers must not use an HFS session to open a protected socket from another origin
                        if (req.headers.origin && req.headers.origin !== `${auth.ctx.protocol}://${auth.ctx.host}`)
                            denied = 403
                    }
                    catch (e) {
                        denied = 401
                        console.error('WebSocket authentication failed:', e)
                    }
                    // unloading or disconnecting during authentication must not create a new upstream connection
                    if (!upgradeServers.has(server) || clientSocket.destroyed) return
                    if (denied) {
                        clientSocket.end(`HTTP/1.1 ${denied} ${denied === 401 ? 'Unauthorized' : 'Forbidden'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
                        return
                    }
                }
                const parsedUrl = new URL(url)
                const targetHost = parsedUrl.hostname
                const targetPort = parseInt(parsedUrl.port) || parsedUrl.protocol === 'https:' && 443 || 80
                const suffix = req.url.slice(path.length)
                const targetPath = parsedUrl.pathname + (parsedUrl.pathname.endsWith('/') && suffix.startsWith('/')
                    ? suffix.slice(1) : suffix)
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
                    clientSocket.write(header.replace(/^(Sec-WebSocket-Accept:\s+).+$/im, '$1' + accept)
                        + cookies.map(cookie => '\r\nSet-Cookie: ' + cookie).join('') + '\r\n\r\n', 'latin1')
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
        upgradeServers.add(server)
        server.on('upgrade', handler)
        return () => {
            server.removeListener('upgrade', handler)
            upgradeServers.delete(server)
        }
    }

}
