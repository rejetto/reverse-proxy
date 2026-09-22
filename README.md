# reverse-proxy

HFS plugin to proxy configured paths to other servers

<img width="400" alt="image" src="https://github.com/user-attachments/assets/9ab88fdc-bdab-43b5-8bab-bba1c6f6e396">

HFS ~ HTTP File Server https://github.com/rejetto/hfs

Install from **HFS Admin → Plugins → Get more**: search for `reverse-proxy` and install it.
Then return to the installed plugins list and click the **Options button on the reverse-proxy row** to configure routes.

HFS internal URLs under `/~/` are never forwarded, even with a catch-all `/` route,
so HFS login, APIs and interface assets remain accessible. WebSocket upgrades under `/~/` are rejected.

## Protected routes

Set **Allowed accounts** on a route to restrict it to those HFS accounts or members of the selected groups.
Leave the field empty for public access. The first matching route still wins: denied requests do not fall through
to a later public rule. Protect every route that exposes the application, including any separate WebSocket or API routes.

Browser navigation to a protected URL displays the standard HFS login dialog and returns to the same URL after login.
Other HTTP requests receive `401` when not authenticated or `403` when the account has no access.
HTTP and WebSocket handshakes use HFS authentication, including session signatures, expiry, revocation,
account restrictions and group membership. HTTP Basic authentication follows HFS's settings and login hooks.
When HFS is behind a TLS-terminating proxy, configure HFS's trusted proxy count so HTTPS sessions and client addresses
are interpreted correctly. Protected browser WebSockets must originate from the same origin as HFS.

Normally, log out through the HFS interface on the same host.
If a catch-all `/` route replaces that interface with the upstream application, the plugin provides an **optional logout page**
at `/~/plugins/reverse-proxy/session.html` on that host. It shows the current HFS account and a logout button.
This page is not required to protect routes or log in. You can link it from the upstream application;
the plugin does not add a logout button to proxied pages automatically.
The page uses HFS's standard logout API and logs out of HFS, not the upstream application's own account.

Access is checked on each HTTP request and
WebSocket handshake; logout or account changes do not forcibly disconnect WebSockets that are already open.

## Domain roots

Source paths refer to the public request URL, before HFS applies a domain root.
For example, use `/app` even if the domain's HFS root is `/documents`.
HTTP, WebSocket connections, redirects and HTML/CSS rewriting use this same public path.

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
