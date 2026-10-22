/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Websocket URL of the µFW server this deployment talks to; set in `.env` or `.env.<deployment>`. */
  readonly VITE_SERVER_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
