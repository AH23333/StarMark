import { defineConfig } from 'wxt'

// See https://wxt.dev/api/config.html

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'StarMark',
    default_locale: 'zh_CN',
    description: '__MSG_extDesc__',
    permissions: ['bookmarks', 'storage', 'sidePanel', 'alarms', 'contextMenus', 'declarativeNetRequest'],
    // localhost:11434 = Ollama 本地模型（扩展页面跨域需显式授权）；github.com = 热榜页抓取
    host_permissions: ['https://github.com/*', 'http://localhost:11434/*', 'http://127.0.0.1/*'],
    commands: {
      'open-sidepanel': {
        suggested_key: { default: 'Alt+S', mac: 'MacCtrl+Shift+S' },
        description: '__MSG_cmdOpenSidepanelDesc__',
      },
    },
    omnibox: { keyword: 'st' },
    action: { default_title: 'StarMark' },
    minimum_chrome_version: '116',
  },
  hooks: {
    // HTML options 入口默认生成 open_in_tab:false，这里强制整页标签打开设置页
    'build:manifestGenerated'(_wxt, manifest) {
      manifest.options_ui = { ...manifest.options_ui, open_in_tab: true } as typeof manifest.options_ui
    },
  },
})