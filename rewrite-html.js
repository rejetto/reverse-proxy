const { parse } = require('parse5')
const { Readable } = require('node:stream')
const rewriteCss = require('./rewrite-css')

// buffer at most 2 MiB; larger documents pass through without rewriting
const limit = 2 * 1024 * 1024

module.exports = async function rewriteResponse(response, sourcePath, destination) {
    const headers = response.headers
    const type = headers['content-type'] || ''
    const charset = /;\s*charset\s*=\s*"?([^;"\s]+)/i.exec(type)?.[1]
    const isCss = /^text\/css(?:;|$)/i.test(type)
    if (!/^text\/(html|css)(?:;|$)/i.test(type) || charset && !/^utf-8$/i.test(charset)
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
    let source
    try { source = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(original) }
    catch { return original }
    const nodes = isCss ? [] : [parse(source, { sourceCodeLocationInfo: true })]
    const edits = new Map()
    const upstream = new URL(destination)
    const basePath = upstream.pathname.replace(/\/$/, '')
    const prefix = sourcePath.replace(/\/$/, '')
    // hashed inline styles must retain their exact bytes to satisfy the upstream CSP
    let hashedStyles = /'sha(?:256|384|512)-/i.test(headers['content-security-policy'] || '')
    for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i]
        for (const child of node.childNodes || []) nodes.push(child)
        if (node.content) nodes.push(node.content)
        // an explicit document base changes the meaning of all relative references
        if (node.tagName === 'base' && node.attrs.some(attr => attr.name === 'href')) return original
        if (node.tagName === 'meta'
            && node.attrs.some(attr => attr.name === 'http-equiv' && attr.value.toLowerCase() === 'content-security-policy')
            && node.attrs.some(attr => attr.name === 'content' && /'sha(?:256|384|512)-/i.test(attr.value)))
            hashedStyles = true
    }
    for (const node of nodes) {
        if (node.tagName === 'style' && !hashedStyles
            && !node.attrs.some(attr => attr.name === 'type' && attr.value && attr.value.toLowerCase() !== 'text/css')) {
            const location = node.sourceCodeLocation
            if (location?.startTag && location.endTag) {
                const start = location.startTag.endOffset, end = location.endTag.startOffset
                const css = source.slice(start, end)
                const text = rewriteCss(css, mapUrl)
                if (text !== css) edits.set(start, { start, end, text })
            }
        }
        for (const attr of node.attrs || []) {
            const value = attr.value
            let mapped
            if (attr.name === 'style' && !hashedStyles)
                mapped = rewriteCss(value, mapUrl, 'declarationList')
            else if (/^(href|src|action|formaction|poster|cite|background)$/.test(attr.name))
                mapped = mapUrl(value)
            else continue
            if (mapped === value) continue
            const location = node.sourceCodeLocation?.attrs?.[attr.name]
            if (!location) continue
            // replace only the parsed attribute; script text, comments and formatting stay intact
            const escaped = mapped.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
            // parser reconstruction can give multiple nodes the same original attribute
            edits.set(location.startOffset, { start: location.startOffset, end: location.endOffset, text: `${attr.name}="${escaped}"` })
        }
    }
    if (isCss) {
        const text = rewriteCss(source, mapUrl)
        if (text !== source) edits.set(0, { start: 0, end: source.length, text })
    }
    if (!edits.size) return original
    const parts = []
    let offset = 0
    for (const edit of [...edits.values()].sort((a, b) => a.start - b.start)) {
        parts.push(source.slice(offset, edit.start), edit.text)
        offset = edit.end
    }
    parts.push(source.slice(offset))
    const body = Buffer.from(parts.join(''))
    // upstream validators and byte counts describe the original representation
    for (const name of ['content-length', 'transfer-encoding', 'etag', 'last-modified', 'content-md5', 'digest', 'content-digest', 'repr-digest'])
        delete headers[name]
    headers['content-length'] = String(body.length)
    return body

    function mapUrl(value) {
        if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return value
        let target
        try { target = new URL(value, upstream) }
        catch { return value } // an invalid link must not prevent the page from loading
        const pathname = target.pathname
        if (target.origin !== upstream.origin
            || pathname !== basePath && !pathname.startsWith(basePath + '/')) return value
        return (prefix + pathname.slice(basePath.length) || '/') + target.search + target.hash
    }
}
