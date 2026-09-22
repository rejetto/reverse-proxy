# reverse-proxy

HFS plugin to proxy configured paths to other servers

<img width="400" alt="image" src="https://github.com/user-attachments/assets/9ab88fdc-bdab-43b5-8bab-bba1c6f6e396">

HFS ~ HTTP File Server https://github.com/rejetto/hfs

## Domain roots

Source paths refer to the public request URL, before HFS applies a domain root.
For example, use `/app` even if the domain's HFS root is `/documents`.
HTTP, WebSocket connections, redirects and HTML/CSS rewriting use this same public path.

On the first start after upgrading to 3.12, existing source paths are migrated automatically:
`/documents/app` becomes `/app` when `/documents` is a configured domain root.
For routes with a source host, only that host's effective root is considered.
Routes without a source host use the longest matching root prefix across all domains.
Only complete path segments match; `/doc` does not match `/documents`.

The migration assumes matching prefixes were added to compensate for HFS domain roots.
It saves the converted routes and `pathsMigrationDone: true` under
`plugins_config` → `reverse-proxy` in HFS's `config.yaml`.
This internal flag prevents further conversion after restarts or configuration changes.

## Adapting HTML and CSS URLs to a subpath

Enable **Rewrite HTML/CSS URLs** on an individual route only when the upstream application needs it.
It is disabled by default. For example, with source `/app` and destination `http://localhost:3000`,
`<script src="/app.js">` becomes `<script src="/app/app.js">`.
With destination `http://localhost:3000/site`, only URLs within `/site` are mapped to `/app`.

This rewrites root-relative `href`, `src`, `action`, `formaction`, `poster`, `cite` and `background`
attributes. A bundled HTML parser identifies attributes without changing script contents or comments.
CSS `url(...)` references and `@import` URLs are also rewritten, in external stylesheets, `<style>` blocks
and `style` attributes. For example, `url(/images/logo.svg)` becomes `url(/app/images/logo.svg)`.
Relative URLs, external URLs, `data:` URLs, fragment references, comments and ordinary CSS strings remain unchanged.
JavaScript URLs (including WebSocket connections), `srcset`, cookies and absolute URLs are not rewritten.
Prefer the application's own base URL setting when available; this option does not provide universal subpath support.
For example, Socket.IO's default `io()` still needs a route for `/socket.io`.

The proxy requests uncompressed upstream responses on this route. Rewriting applies to HTML and CSS up to 2 MiB,
declared as UTF-8 (or ASCII-only HTML without a charset). Compressed responses, other encodings,
partial responses, `Cache-Control: no-transform`, and documents with an explicit `<base href>` pass through unchanged.
Larger documents also pass through unchanged, including when their size was not known in advance.
CSS that the parser cannot interpret passes through unchanged. Inline CSS is left untouched when the page's
CSP contains hashes. External stylesheets with Subresource Integrity are incompatible with rewriting their contents;
the plugin does not remove integrity checks. Configure the application's base URL instead in that case.

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
It also checks opt-in HTML/CSS rewriting and unchanged fallback responses.

For a real browser test, install the dependencies of the official
[Socket.IO chat example](https://github.com/socketio/chat-example/tree/cjs/step5), then run:

```sh
npm ci
npx playwright install chromium
CHAT_DIR=/path/to/chat-example HFS_DIR=/path/to/hfs node tests/html-browser.cjs
```

This uses Playwright and Chromium. It starts isolated servers,
checks script URLs with the option enabled and disabled, and exchanges messages between two browser tabs
over real WebSockets, including after a page reload. The chat's HTML and JavaScript are unchanged.
An additional page checks an external stylesheet, an imported stylesheet, a real font and background images,
including inline CSS, all loaded through HFS under a path prefix.

## Building

After changing `rewrite-html.js` or `rewrite-css.js`, run `npm ci && npm run build` to update the bundle in `dist`.
The parsers and their licenses are distributed with the plugin; users do not need npm.
