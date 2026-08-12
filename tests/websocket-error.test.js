const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const test = require('node:test')

test('closes the other side when a WebSocket socket fails', () => {
    const server = new EventEmitter()
    const upstream = Object.assign(new EventEmitter(), {
        write() {},
        destroy() { this.destroyed = true },
    })
    const client = Object.assign(new EventEmitter(), {
        socket: { remoteAddress: '127.0.0.1' },
        destroy() { this.destroyed = true },
    })
    const api = {
        onServer: cb => cb(server),
        getConfig: key => key === 'routes' ? [{ path: '/ws', url: 'http://upstream' }] : false,
        require: name => name === 'net' ? { connect: () => upstream } : require(name),
    }

    require('../dist/plugin.js').init(api)
    server.emit('upgrade', {
        method: 'GET', url: '/ws', socket: client.socket,
        headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-key': 'key' },
    }, client)

    upstream.emit('error', new Error('ECONNREFUSED'))
    assert.equal(client.destroyed, true)
    client.emit('error', new Error('ECONNRESET'))
    assert.equal(upstream.destroyed, true)
})
