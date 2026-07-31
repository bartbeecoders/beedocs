/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_BEEDOCS_API_PATH_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
