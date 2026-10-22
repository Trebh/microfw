/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Websocket origin (`ws://host:port`, no path) of the µFW server this deployment talks to; each definition is served under its own path. Set in `.env` or `.env.<deployment>`. */
  readonly VITE_SERVER_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
