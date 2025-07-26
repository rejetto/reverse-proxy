exports.version = 1.21
exports.apiRequired = 8.72 // httpStream.httpThrow
exports.description = "HFS already works with a proxy (once configured), but this plugin adds the capability to ACT as a proxy server."
exports.repo = "rejetto/reverse-proxy"
exports.preview = "https://github.com/user-attachments/assets/9ab88fdc-bdab-43b5-8bab-bba1c6f6e396"
exports.changelog = [
    { "version": 1.1, "message": "Better redirection support" },
    { "version": 1.21, "message": "Match routes by host" },
]

exports.config = {
    routes: {
        type: 'array', defaultValue: [], width: { sm: 600 },
        fields: {
            path: { label: 'Source path', placeholder: '/website' },
            host: { label: 'Source host', placeholder: "leave empty for any" },
            url: { label: 'Destination URL', placeholder: 'http://example.com' }
        }
    },
}

exports.init = api => ({
    async middleware(ctx) {
        for (const route of api.getConfig('routes')) {
            let { path='', host, url } = route
            if (host && ctx.host !== host) continue
            if (!path.startsWith('/'))
                path = '/' + path
            if (!ctx.url.startsWith(path)) continue
            if (path.length > 1 && ctx.url.length > path.length && ctx.url[path.length] !== '/') continue
            if (url.endsWith('/'))
                url = url.slice(0, -1)
            const dest = url + ctx.url.slice(path.length === 1 ? 0 :path.length)
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
                    rejectUnauthorized: false,
                    noRedirect: true, // redirect must be handled differently
                }
                await Promise.all(api.customApiCall('reverseproxy_forward', { ctx, forward }))
                const {url} = forward
                forward.url = undefined // dont' delete, for performance reasons
                const req = await api.require('./misc').httpStream(url, forward)
                if (req.headers.location?.startsWith(url))
                    return ctx.redirect(path + req.headers.location.slice(url.length))
                ctx.status = req.statusCode
                ctx.set(req.headers)
                ctx.body = req
            }
            catch (e) {
                ctx.status = 502
                ctx.body = String(e)
            }
            return
        }
    }
})