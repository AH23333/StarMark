/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 可选：部署环境 */
  readonly VITE_ENV?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}