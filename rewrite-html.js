const { parse } = require('parse5')
const { Readable } = require('node:stream')

// buffer at most 2 MiB; larger documents pass through without rewriting
const limit = 2 * 1024 * 1024

module.exports = async function rewriteHtml(response, sourcePath, destination) {
    const headers = response.headers
    const type = headers['content-type'] || ''
    const charset = /;\s*charset\s*=\s*"?([^;"\s]+)/i.exec(type)?.[1]
    if (!/^text\/html(?:;|$)/i.test(type) || charset && !/^utf-8$/i.test(charset)
        || headers['content-encoding'] && headers['content-encoding'] !== 'identity'
        || response.statusCode === 206 || /\bno-transform\b/i.test(headers['cache-control'] || '')
        || Number(headers['content-length']) > limit)
        return response
    const chunks = []
    let length = 0
    const iterator = response[Symbol.asyncIterator]()
    while (true) {
        const { value, done } = await iterator.next()
        if (done) break
        chunks.push(value)
        length += value.length
        if (length > limit) {
            // replay the consumed prefix before resuming the same upstream iterator
            return Readable.from((async function* () {
                try {
                    yield* chunks
                    while (true) {
                        const { value, done } = await iterator.next()
                        if (done) break
                        yield value
                    }
                } finally { await iterator.return() }
            })())
        }
    }
    const original = Buffer.concat(chunks)
    // a buffered Koa body gets Content-Length, so it must not retain chunked framing
    delete headers['transfer-encoding']
    // without a declared charset, only ASCII is unambiguous across legacy encodings
    if (!charset && original.some(byte => byte > 127)) return original
    let html
    try { html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(original) }
    catch { return original }
    const document = parse(html, { sourceCodeLocationInfo: true })
    const nodes = [document]
    const edits = new Map()
    const upstream = new URL(destination)
    const basePath = upstream.pathname.replace(/\/$/, '')
    const prefix = sourcePath.replace(/\/$/, '')
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]
        for (const child of node.childNodes || []) nodes.push(child)
        if (node.content) nodes.push(node.content)
        // an explicit document base changes the meaning of all relative references
        if (node.tagName === 'base' && node.attrs.some(attr => attr.name === 'href')) return original
        for (const attr of node.attrs || []) {
            if (!/^(href|src|action|formaction|poster|cite|background)$/.test(attr.name)) continue
            const value = attr.value
            if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) continue
            let target
            try { target = new URL(value, upstream) }
            catch { continue } // an invalid link must not prevent the page from loading
            if (target.origin !== upstream.origin) continue
            const pathname = target.pathname
            if (pathname !== basePath && !pathname.startsWith(basePath + '/')) continue
            const mapped = (prefix + pathname.slice(basePath.length) || '/') + target.search + target.hash
            if (mapped === value) continue
            const location = node.sourceCodeLocation?.attrs?.[attr.name]
            if (!location) continue
            // replace only the parsed attribute; script text, comments and formatting stay intact
            const escaped = mapped.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
            // parser reconstruction can give multiple nodes the same original attribute
            edits.set(location.startOffset, { start: location.startOffset, end: location.endOffset, text: `${attr.name}="${escaped}"` })
        }
    }
    if (!edits.size) return original
    const parts = []
    let offset = 0
    for (const edit of [...edits.values()].sort((a, b) => a.start - b.start)) {
        parts.push(html.slice(offset, edit.start), edit.text)
        offset = edit.end
    }
    parts.push(html.slice(offset))
    const body = Buffer.from(parts.join(''))
    // upstream validators and byte counts describe the original representation
    for (const name of ['content-length', 'transfer-encoding', 'etag', 'last-modified', 'content-md5', 'digest', 'content-digest', 'repr-digest'])
        delete headers[name]
    headers['content-length'] = String(body.length)
    return body
}
