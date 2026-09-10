# reverse-proxy

HFS plugin to proxy configured paths to other servers

<img width="400" alt="image" src="https://github.com/user-attachments/assets/9ab88fdc-bdab-43b5-8bab-bba1c6f6e396">

HFS ~ HTTP File Server https://github.com/rejetto/hfs

## Adapting HTML links to a subpath

Enable **Rewrite HTML URLs** on an individual route only when the upstream application needs it.
It is disabled by default. For example, with source `/app` and destination `http://localhost:3000`,
`<script src="/app.js">` becomes `<script src="/app/app.js">`.
With destination `http://localhost:3000/site`, only URLs within `/site` are mapped to `/app`.

This rewrites root-relative `href`, `src`, `action`, `formaction`, `poster`, `cite` and `background`
attributes. A bundled HTML parser identifies attributes without changing script contents or comments.
JavaScript URLs (including WebSocket connections), CSS, `srcset`, cookies and absolute URLs are not rewritten.
Prefer the application's own base URL setting when available; this option does not provide universal subpath support.
For example, Socket.IO's default `io()` still needs a route for `/socket.io`.

The proxy requests uncompressed upstream responses on this route. Rewriting applies to HTML up to 2 MiB,
declared as UTF-8 (or ASCII-only HTML without a charset). Compressed responses, other encodings,
partial responses, `Cache-Control: no-transform`, and documents with an explicit `<base href>` pass through unchanged.
Larger documents also pass through unchanged, including when their size was not known in advance.

## Messing with forwarded requests

On every forwarded request, this plugin is calling customApi `reverseproxy_forward`.
If your code/plugin exports this customApi, you can interact with it.

```js
exports.customApi =  {
    reverseproxy_forward({ forward, ctx }) {
        // here you can see and modify the request we are about to forward
        console.log(forward)
        // forward is an object { url, method, headers, body }
        // if you change its content, it will affect forwarded request.
    }
}
```

## Tests

Run `HFS_DIR=/path/to/hfs node --test tests/*.test.js` with a built HFS checkout.
The integration test starts an isolated HFS instance and a local HTTP/WebSocket upstream on loopback ports.
It covers route boundaries, fragmented handshakes, binary frames, plugin reloads and redirects.
It also checks opt-in HTML rewriting and unchanged fallback responses.

For a real browser test, install the dependencies of the official
[Socket.IO chat example](https://github.com/socketio/chat-example/tree/cjs/step5), then run:

```sh
CHAT_DIR=/path/to/chat-example HFS_DIR=/path/to/hfs node tests/html-browser.cjs
```

This uses the HFS checkout's Playwright installation and Chromium. It starts isolated servers,
checks script URLs with the option enabled and disabled, and exchanges messages between two browser tabs
over real WebSockets, including after a page reload. The chat's HTML and JavaScript are unchanged.

## Building

After changing `rewrite-html.js`, run `npm ci && npm run build` to update its bundled copy in `dist`.
The parser and its licenses are distributed with the plugin; users do not need npm.
