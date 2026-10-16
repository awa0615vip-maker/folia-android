// src/utils/platform.ts
// One place to answer "is this a Mac", so keyboard handling and the shortcut hints the user reads
// can never disagree about it. Detection is by user agent because the renderer runs both in a
// browser and in Electron, and `window.electron?.platform` only exists in the latter.

export const isMacPlatform = typeof navigator !== 'undefined'
    && navigator.userAgent.toLowerCase().includes('mac');

/**
 * The modifier a shortcut declared as `ctrl` actually uses here: Cmd on macOS, Ctrl elsewhere.
 * Shortcuts are declared once with `ctrl` and translated at the point of use, rather than each
 * declaration carrying a per-platform variant.
 */
export const isPrimaryModifierPressed = (event: KeyboardEvent): boolean => (
    isMacPlatform ? event.metaKey : event.ctrlKey
);

/** The modifier that must stay *up* for a primary-modifier shortcut to be unambiguous. */
export const isSecondaryModifierPressed = (event: KeyboardEvent): boolean => (
    isMacPlatform ? event.ctrlKey : event.metaKey
);

/** Label for the primary modifier, for shortcut hints shown in the UI. */
export const PRIMARY_MODIFIER_LABEL = isMacPlatform ? 'Cmd' : 'Ctrl';

/**
 * Is the UI running inside the Folia Android native shell (Capacitor WebView), rather than a
 * desktop browser / Electron? Used to pick phone-friendly rendering defaults (MSAA off, capped
 * frame rate / DPR). The app never ships a browser build on this platform, but keeping this a
 * capability probe (not a build flag) lets the same bundle run unchanged in a desktop browser.
 */
export const isAndroidNativeRuntime = (): boolean => (
    typeof window !== 'undefined'
    && (window as unknown as { Capacitor?: { getPlatform?: () => string } })?.Capacitor?.getPlatform?.() === 'android'
);

/** Evaluated once at module load: mobile renderers read this to avoid re-probing every frame. */
export const IS_ANDROID_WEBVIEW = isAndroidNativeRuntime();
