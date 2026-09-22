if (document.querySelector('meta[name="hfs-proxy-login"]')) {
    HFS.state.loginRequired = true
    HFS.onEvent('loginOk', () => location.reload())
}
