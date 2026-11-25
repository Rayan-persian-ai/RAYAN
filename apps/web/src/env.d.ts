/// <reference types="vite/client" />
interface ImportMetaEnv {
  /** Absolute API origin for builds served outside Cloudflare Pages (Android/Windows shells). Empty = same origin. */
  readonly VITE_API_BASE_URL?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
