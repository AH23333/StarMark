// 全局错误捕获浮层：白屏时错误直接显示在页面上（CSP 合规的外链脚本）
function showOverlay(prefix, text) {
  const el = document.createElement('pre')
  el.id = 'starmark-error-overlay'
  el.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#fee2e2;color:#991b1b;padding:12px;font:12px monospace;white-space:pre-wrap;margin:0'
  el.textContent = prefix + text
  if (document.body) document.body.prepend(el)
  else document.addEventListener('DOMContentLoaded', () => document.body.prepend(el))
}
window.addEventListener('error', (e) => {
  showOverlay('[Error] ', (e.message || '') + '\n' + ((e.filename || '') + ':' + (e.lineno || '')))
})
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason
  showOverlay('[Promise] ', (r && (r.stack || r.message)) || String(r))
})
