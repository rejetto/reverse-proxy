exports.version = 2.22
exports.apiRequired = 12.7 // 'onServer' event
exports.description = "With this plugin HFS becomes a proxy server"
exports.repo = "rejetto/reverse-proxy"
exports.preview = ["https://github.com/user-attachments/assets/9ab88fdc-bdab-43b5-8bab-bba1c6f6e396"]
exports.changelog = [
    { "version": 2.22, "message": "Rewrite root-relative paths in proxied pages, and retry requests (HTTP and WebSocket) rejected with 403 without Origin/Referer" },
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
            url: { label: 'Destination URL', $width: 2, placeholder: 'http://example.com' }
        }
    },
    rejectUnauthorized: { type: 'boolean', defaultValue: false, label: "Validate upstream TLS certificates" },
    debug: { type: 'boolean', defaultValue: false, label: "Log proxied requests and websocket handshakes" },
}

exports.init = api => {
    api.onServer(handleWebsockets)
    const REWRITE_LIMIT = 8 * 1024 * 1024 // pages bigger than this are streamed as-is
    const FORBIDDEN_TTL = 10 * 60 * 1000 // how long a 403 is remembered
    const WS_UPSTREAM_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11' // RFC 6455

    const debug = (...args) => {
        if (api.getConfig('debug'))
            api.log(...args)
    }

    // Requests answered with 403 by the upstream, as "METHOD url" -> timestamp: some upstreams
    // (e.g. apps with a CSRF check) refuse requests carrying a foreign Origin/Referer, so these
    // are forwarded without those headers.
    const forbidden = new Map()

    const isForbidden = key => {
        const at = forbidden.get(key)
        if (at === undefined) return false
        if (Date.now() - at <= FORBIDDEN_TTL) return true
        forbidden.delete(key)
        return false
    }
    const rememberForbidden = key => forbidden.set(key, Date.now())

    const stripHeaders = headers => {
        delete headers.origin
        delete headers.referer
    }

    // First rule matching applies
    function matchRoute(uri, host) {
        for (const { path = '', host: routeHost, url } of api.getConfig('routes')) {
            if (!url) continue
            if (routeHost && host !== routeHost) continue
            const src = path.startsWith('/') ? path : '/' + path
            if (!uri.startsWith(src)) continue
            if (src.length > 1 && uri.length > src.length && uri[src.length] !== '/') continue
            const base = url.endsWith('/') ? url.slice(0, -1) : url
            return { path: src, dest: base + uri.slice(src.length === 1 ? 0 : src.length) }
        }
    }

    function rewriteHtml(html, path) {
        const prefix = p => p === path || p.startsWith(path + '/') ? p : path + p
        // root-relative paths in common url attributes
        html = html.replace(/\b(href|src|action|formaction|poster|cite|data-src|background)\s*=\s*(['"])\/(?!\/)([^'"\s>]*)\2/gi,
            (m, attr, q, p) => attr + '=' + q + prefix('/' + p) + q)
        // srcset
        html = html.replace(/\b(srcset)\s*=\s*(['"])([\s\S]*?)\2/gi,
            (m, attr, q, v) => attr + '=' + q + v.replace(/(^|,\s*)\/(?!\/)([^\s,]+)/g, (m2, pre, p) => pre + prefix('/' + p)) + q)
        // css url()
        html = html.replace(/url\(\s*(['"]?)\/(?!\/)([^'") \t\n\r]+)\1\s*\)/gi,
            (m, q, p) => 'url(' + q + prefix('/' + p) + q + ')')
        // quoted strings in inline js/json (e.g. window.__DSH_BOOT__ = {"url":"/plugins/..."})
        html = html.replace(/(["'])\/(?!\/)(?!\*)(?!\1)[^"'<>\s]*\1/g,
            (m, q) => q + prefix(m.slice(1, -1)) + q)
        return html
    }

    // Buffer a possibly compressed body, up to the limit
    function readBody(stream, enc) {
        return new Promise((resolve, reject) => {
            const zlib = api.require('zlib')
            const src = enc === 'gzip' ? stream.pipe(zlib.createGunzip())
                : enc === 'deflate' ? stream.pipe(zlib.createInflate())
                : enc === 'br' ? stream.pipe(zlib.createBrotliDecompress())
                : stream
            const charset = /charset=([\w-]+)/i.exec(stream.headers['content-type'] || '')?.[1]
            const chunks = []
            let size = 0
            src.on('data', c => {
                if ((size += c.length) > REWRITE_LIMIT) {
                    stream.destroy()
                    return reject(Error('body too large to buffer'))
                }
                chunks.push(c)
            })
            src.on('end', () => {
                const buf = Buffer.concat(chunks)
                try { resolve(new TextDecoder(charset || 'utf-8').decode(buf)) }
                catch { resolve(buf.toString('utf8')) } // unknown charset
            })
            src.on('error', reject)
        })
    }

    return {
        async middleware(ctx) {
            const route = matchRoute(ctx.url, ctx.host)
            if (!route) return
            const { path, dest } = route
            debug(ctx.method, ctx.url, '->', dest)
            const { host } = api.require('url').parse(dest)
            const key = ctx.method + ' ' + dest
            let body = ctx.req
            if (!['GET', 'HEAD'].includes(ctx.method)) { // buffer it, so a retry can replay it
                const len = Number(ctx.headers['content-length'])
                if (len > 0 && len <= REWRITE_LIMIT)
                    body = await readBody(ctx.req, ctx.headers['content-encoding'])
            }
            const forward = {
                url: dest,
                method: ctx.method,
                headers: {
                    ...ctx.headers,
                    host,
                    'X-Forwarded-For': ctx.ip,
                    'X-Forwarded-Proto': ctx.protocol,
                    'X-Forwarded-Host': ctx.host,
                },
                body,
                httpThrow: false,
                rejectUnauthorized: api.getConfig('rejectUnauthorized'),
                noRedirect: true, // redirect must be handled differently
            }
            if (isForbidden(key))
                stripHeaders(forward.headers)
            try {
                await Promise.all(api.customApiCall('reverseproxy_forward', { ctx, forward })) // allow plugins to interact
                const { url } = forward
                forward.url = undefined // dont' delete, for performance reasons
                let res = await api.require('./misc').httpStream(url, forward)
                if (res.statusCode === 403 && !isForbidden(key)) { // maybe it's the Origin/Referer: retry once without them
                    debug(dest, '403, retrying without Origin/Referer')
                    rememberForbidden(key)
                    if (body !== ctx.req || ['GET', 'HEAD'].includes(ctx.method)) {
                        res.resume() // discard the body, so the connection can be reused
                        stripHeaders(forward.headers)
                        forward.url = url
                        res = await api.require('./misc').httpStream(url, forward)
                    }
                }
                const location = res.headers.location
                if (location?.startsWith(dest))
                    return ctx.redirect(path + location.slice(dest.length))
                if (path !== '/' && location?.startsWith('/') && !location.startsWith('//'))
                    return ctx.redirect(path + location) // root-relative redirect, must keep the source path
                ctx.status = res.statusCode
                ctx.set(res.headers)
                const enc = String(res.headers['content-encoding'] || '').toLowerCase()
                const rewritable = ctx.method !== 'HEAD' && path !== '/' && /html/i.test(res.headers['content-type'] || '')
                    && (!enc || enc === 'gzip' || enc === 'deflate' || enc === 'br')
                    && (!res.headers['content-length'] || Number(res.headers['content-length']) <= REWRITE_LIMIT)
                if (rewritable) {
                    ctx.remove('content-length')
                    ctx.remove('content-encoding')
                    ctx.body = rewriteHtml(await readBody(res, enc), path)
                }
                else
                    ctx.body = res
            }
            catch (e) {
                ctx.status = 502
                ctx.body = String(e)
            }
        },
    }

    function handleWebsockets(server) {
        // HFS removes api.events subscriptions on unload, but not the listeners we add to the server
        // itself, so every reload would leave a stale instance destroying sockets it can't handle.
        // The marker is shared by all instances, so the newest one removes any previous handler.
        const marker = 'reverseproxy_upgrade_handler'
        const previous = server[marker]
        if (previous)
            server.removeListener('upgrade', previous)
        const handler = (req, clientSocket) => {
            try {
                upgrade(req, clientSocket)
            }
            catch (e) {
                api.log('websocket proxy:', String(e))
                clientSocket.destroy()
            }
        }
        server[marker] = handler
        server.on('upgrade', handler)
    }

    function upgrade(req, clientSocket) {
        if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket'
            || !String(req.headers.connection || '').toLowerCase().includes('upgrade')) return
        const key = req.headers['sec-websocket-key']
        const route = matchRoute(req.url, req.headers.host)
        if (!key || !route) {
            debug('websocket', req.url, key ? 'no route' : 'no sec-websocket-key')
            return clientSocket.destroy()
        }
        const target = new URL(route.dest)
        const port = Number(target.port) || (target.protocol === 'https:' ? 443 : 80)
        const targetPath = target.pathname + target.search
        const cacheKey = 'GET ' + route.dest
        const accept = api.require('crypto').createHash('sha1').update(key + WS_UPSTREAM_GUID).digest('base64')
        let stripped = isForbidden(cacheKey)
        let retried = false
        debug('websocket', req.url, '->', route.dest, stripped ? '(without Origin/Referer)' : '')

        const connect = () => {
            const headers = {
                ...req.headers,
                host: target.host,
                'X-Forwarded-For': req.socket.remoteAddress,
                'X-Forwarded-Proto': req.socket.encrypted ? 'https' : 'http',
                'X-Forwarded-Host': req.headers.host,
            }
            if (stripped)
                stripHeaders(headers)
            const request = [`${req.method} ${targetPath} HTTP/1.1`,
                ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`)].join('\r\n') + '\r\n\r\n'
            const socket = api.require(target.protocol === 'https:' ? 'tls' : 'net').connect({
                host: target.hostname,
                port,
                ...target.protocol === 'https:' && { rejectUnauthorized: api.getConfig('rejectUnauthorized') },
            })
            socket.on('connect', () => socket.write(request))
            return socket
        }

        const retry = () => {
            if (retried || stripped) return false
            retried = stripped = true
            rememberForbidden(cacheKey)
            return true
        }

        const tunnel = () => {
            const socket = connect()
            let header = ''
            socket.on('data', data => {
                if (clientSocket.upgraded) return
                header += data
                const end = header.indexOf('\r\n\r\n') // the header may arrive in several chunks
                if (end < 0) {
                    if (header.length > 64 * 1024) { // unreasonably big, something's wrong
                        clientSocket.destroy()
                        socket.destroy()
                    }
                    return
                }
                const rest = header.slice(end + 4)
                header = header.slice(0, end)
                if (!/^HTTP\/1\.[01] 101 /i.test(header)) { // the upstream refused the upgrade
                    socket.destroy()
                    const status = header.split('\r\n')[0]
                    if (!retry() || !/^HTTP\/1\.[01] 403 /i.test(header)) {
                        debug('websocket rejected', targetPath, status)
                        return clientSocket.destroy()
                    }
                    debug('websocket rejected', targetPath, status + ', retrying without Origin/Referer')
                    return tunnel()
                }
                clientSocket.write(header.replace(/^(Sec-WebSocket-Accept:\s+).+$/im, '$1' + accept) + '\r\n\r\n')
                clientSocket.upgraded = true
                if (rest)
                    clientSocket.write(rest) // bytes already read beyond the header
                clientSocket.pipe(socket).pipe(clientSocket) // pipe data between client and upstream
            })
            socket.on('error', () => clientSocket.destroy())
            socket.on('timeout', () => {
                clientSocket.destroy()
                socket.destroy()
            })
            // the upstream closed before answering: give up, or the client would hang
            socket.on('close', () => clientSocket.upgraded ? clientSocket.end() : clientSocket.destroy())
            clientSocket.on('error', () => socket.destroy())
        }
        tunnel()
    }
}
