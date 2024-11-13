# reverse-proxy

HFS plugin to proxy configured paths to other servers

<img width="400" alt="image" src="https://github.com/user-attachments/assets/9ab88fdc-bdab-43b5-8bab-bba1c6f6e396">

HFS ~ HTTP File Server https://github.com/rejetto/hfs

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