/**
 * RAYAN (رایان) — Android shell configuration (Capacitor 6).
 *
 * The shell bundles the Vite build of apps/web (../web/dist) into the APK.
 * Environment variables read at `cap sync` time (all optional):
 *
 *   RAYAN_API_BASE_URL  Base URL of the RAYAN API (Cloudflare Worker), e.g.
 *                       https://rayan-api.<account>.workers.dev
 *                       Written to rayan-config.json inside the bundled web
 *                       assets by scripts/post-sync.mjs (runtime override).
 *                       The web build itself should also receive it as
 *                       VITE_API_BASE_URL (the CI workflow does this).
 *   RAYAN_LIVE_URL      If set, the app loads this hosted URL instead of the
 *                       bundled files ("live" mode). offline.html is shown
 *                       when it cannot be reached. Leave unset for releases.
 *   RAYAN_DEBUG         "1" enables Chrome WebView debugging (debug builds).
 */
import type { CapacitorConfig } from '@capacitor/cli';

const liveUrl = process.env.RAYAN_LIVE_URL?.trim() || undefined;
const debug = process.env.RAYAN_DEBUG === '1';

const config: CapacitorConfig = {
  appId: 'com.rayan.ai',
  appName: 'رایان',
  webDir: '../web/dist',
  loggingBehavior: debug ? 'debug' : 'production',
  appendUserAgent: 'RayanAndroid/0.1',
  server: {
    // https://localhost origin -> secure context (crypto.subtle, service workers).
    androidScheme: 'https',
    hostname: 'localhost',
    // Shown by the native bridge when the WebView cannot load the page.
    errorPath: 'offline.html',
    ...(liveUrl ? { url: liveUrl, cleartext: false } : {}),
  },
  android: {
    allowMixedContent: false,
    captureInput: true,
    webContentsDebuggingEnabled: debug,
    backgroundColor: '#0f172a',
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1200,
      launchAutoHide: true,
      launchFadeOutDuration: 300,
      backgroundColor: '#0f172a',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: false,
      splashImmersive: false,
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0f172a',
      overlaysWebView: false,
    },
  },
};

export default config;
