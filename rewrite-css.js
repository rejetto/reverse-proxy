const parse = require('css-tree/parser')
const walk = require('css-tree/walker')
const generate = require('css-tree/generator')

module.exports = function rewriteCss(css, mapUrl, context = 'stylesheet') {
    const edits = []
    try {
        const ast = parse(css, { context, positions: true, parseCustomProperty: true,
            onParseError(error) { throw error } })
        walk(ast, function (node) {
            const isImport = this.atrule?.name.toLowerCase() === 'import'
                && this.atrule.prelude?.children.first === node
            if (!(node.type === 'Url' && (this.declaration || isImport)
                || node.type === 'String' && isImport)) return
            const value = mapUrl(node.value)
            if (value !== node.value)
                edits.push({ start: node.loc.start.offset, end: node.loc.end.offset, text: generate({ ...node, value }) })
        })
    } catch { return css } // preserve CSS the parser cannot interpret instead of guessing at URLs
    const parts = []
    let offset = 0
    for (const edit of edits.sort((a, b) => a.start - b.start)) {
        parts.push(css.slice(offset, edit.start), edit.text)
        offset = edit.end
    }
    parts.push(css.slice(offset))
    return parts.join('')
}
