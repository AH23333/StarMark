import { defineConfig } from 'wxt'

// See https://wxt.dev/api/config.html

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'StarMark',
    description: '统一搜索 GitHub Stars 与浏览器书签的本地搜索入口',
    permissions: ['bookmarks', 'storage', 'sidePanel', 'alarms'],
    omnibox: { keyword: 'st' },
    action: { default_title: 'StarMark' },
    minimum_chrome_version: '116',
  },
  hooks: {
    // HTML options 入口默认生成 open_in_tab:false，这里强制整页标签打开设置页
    'build:manifestGenerated'(_wxt, manifest) {
      manifest.options_ui = { ...manifest.options_ui, open_in_tab: true }
    },
  },
})