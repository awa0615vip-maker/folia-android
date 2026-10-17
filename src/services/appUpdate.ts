// 应用内更新：检查 GitHub Releases 最新版、比对版本号、调用原生 DownloadManager 下载 APK 并安装。
//
// 发版约定（重要）：在 GitHub 发 Release 时，Tag 必须与应用 versionName 一致并加 v 前缀，
// 例如应用 versionName = 0.7.17-android.125 时，Tag = v0.7.17-android.125；并把
// v0.7.17-android.125.apk 拖进 Assets。这里按 Tag 末段数字（125 vs 126）判断是否有更新。

import { IS_ANDROID_WEBVIEW } from '../utils/platform';

const REPO_OWNER = 'awa0615vip-maker';
const REPO_NAME = 'folia-android';
const LATEST_RELEASE_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`;
// 最新正式版取不到（例如发的是预发布）时，回退取列表第一个（含预发布）。
const RELEASE_LIST_API = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases?per_page=1`;
const RELEASE_PAGE = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`;

// GitHub 直链在国内常超时：第 0 个直连，其余为加速镜像，下载失败时依次切换。
// 均为公开 GitHub release 转发通道（已实测可转发本仓库 APK，返回 206）。
const MIRROR_PREFIXES = [
    '', // 直连
    'https://ghproxy.net/',
    'https://gh-proxy.com/',
    'https://ghfast.top/',
];

export type AppInfo = {
    versionName: string;
    versionCode: number;
    packageName: string;
};

export type UpdateInfo = {
    currentVersionName: string;
    currentVersionCode: number;
    latestVersionName: string;
    hasUpdate: boolean;
    releaseNotes: string;
    releaseUrl: string;
    apkAssetName: string;
    apkUrl: string;
    sizeBytes: number;
};

export type DownloadProgress = {
    status: 'pending' | 'running' | 'paused' | 'successful' | 'failed' | 'completed' | 'unknown';
    downloaded: number;
    total: number;
    reason: number;
};

type NativePlugin = any;

const getPlugin = (): NativePlugin | null => {
    if (typeof window === 'undefined') return null;
    return (window as any).Capacitor?.Plugins?.FoliaNative ?? null;
};

/** 版本号末段数字：0.7.17-android.125 -> 125。 */
export const trailingVersionNumber = (value: string): number | null => {
    const match = value.match(/(\d+)\D*$/);
    return match ? Number.parseInt(match[1], 10) : null;
};

const decodeBase64Utf8 = (base64: string): string => {
    if (!base64) return '';
    try {
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
            bytes[i] = binary.charCodeAt(i);
        }
        return new TextDecoder('utf-8').decode(bytes);
    } catch {
        return '';
    }
};

/** 优先走原生 OkHttp（不受 WebView 对 GitHub 的网络限制，国内更稳），桌面环境回退 fetch。 */
const nativeGetJson = async (url: string): Promise<any> => {
    const plugin = getPlugin();
    if (plugin?.httpRequest) {
        const result = await plugin.httpRequest({
            url,
            method: 'GET',
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'Folia-Android',
            },
            timeoutMs: 20000,
        });
        if (result.status >= 200 && result.status < 300 && result.bodyBase64) {
            return JSON.parse(decodeBase64Utf8(result.bodyBase64));
        }
        throw new Error(`HTTP ${result.status}`);
    }
    const response = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
};

export const getCurrentAppInfo = async (): Promise<AppInfo> => {
    const plugin = getPlugin();
    if (!plugin?.getAppInfo) {
        throw new Error('FoliaNative.getAppInfo unavailable');
    }
    return plugin.getAppInfo();
};

export const checkForUpdate = async (): Promise<UpdateInfo> => {
    const info = await getCurrentAppInfo();
    let release: any = null;
    try {
        release = await nativeGetJson(LATEST_RELEASE_API);
    } catch {
        release = null;
    }
    // 正式版取不到（发的是预发布，或 latest 空结果）时，回退到列表第一个（含预发布）。
    if (!release || !release.tag_name) {
        const list = await nativeGetJson(RELEASE_LIST_API);
        if (Array.isArray(list) && list.length > 0) {
            release = list[0];
        }
    }
    if (!release || !release.tag_name) {
        throw new Error('No release found');
    }
    const tag = String(release.tag_name || '');
    const latestVersionName = tag.replace(/^[vV]/, '');
    const latestNum = trailingVersionNumber(latestVersionName);
    const currentNum = trailingVersionNumber(info.versionName);
    const assets: any[] = Array.isArray(release.assets) ? release.assets : [];
    const apkAsset = assets.find((asset) =>
        typeof asset?.name === 'string' && asset.name.toLowerCase().endsWith('.apk'));

    const newer = latestNum != null && currentNum != null && latestNum > currentNum;
    return {
        currentVersionName: info.versionName,
        currentVersionCode: info.versionCode,
        latestVersionName,
        hasUpdate: newer && !!apkAsset,
        releaseNotes: String(release.body || '').trim(),
        releaseUrl: release.html_url || RELEASE_PAGE,
        apkAssetName: apkAsset ? String(apkAsset.name) : '',
        apkUrl: apkAsset ? String(apkAsset.browser_download_url) : '',
        sizeBytes: apkAsset ? Number(apkAsset.size) || 0 : 0,
    };
};

/** 生成下载候选：直连在前，其后是加速镜像；去重。 */
export const buildDownloadUrls = (apkUrl: string): string[] => {
    if (!apkUrl) return [];
    const seen = new Set<string>();
    const output: string[] = [];
    MIRROR_PREFIXES.forEach((prefix) => {
        const candidate = prefix ? `${prefix}${apkUrl}` : apkUrl;
        if (!seen.has(candidate)) {
            seen.add(candidate);
            output.push(candidate);
        }
    });
    return output;
};

export const startDownload = async (url: string): Promise<number> => {
    const plugin = getPlugin();
    if (!plugin?.downloadUpdate) {
        throw new Error('FoliaNative.downloadUpdate unavailable');
    }
    const result = await plugin.downloadUpdate({ url });
    return Number(result.downloadId);
};

export const pollDownloadProgress = (downloadId: number): Promise<DownloadProgress> => {
    const plugin = getPlugin();
    if (!plugin?.getDownloadProgress) {
        return Promise.resolve({ status: 'unknown', downloaded: 0, total: 0, reason: 0 });
    }
    return plugin.getDownloadProgress({ downloadId });
};

export const installDownloadedUpdate = async (): Promise<boolean> => {
    const plugin = getPlugin();
    if (!plugin?.installDownloadedUpdate) return false;
    const result = await plugin.installDownloadedUpdate({});
    return !!result.ok;
};

export const subscribeDownloadComplete = (
    callback: (event: { success: boolean; installing: boolean; status: string }) => void,
): (() => void) => {
    const plugin = getPlugin();
    if (!plugin?.addListener) return () => undefined;
    let removed = false;
    Promise.resolve(
        plugin.addListener('updateDownloadComplete', (event: any) => {
            callback({
                success: !!event?.success,
                installing: !!event?.installing,
                status: String(event?.status || ''),
            });
        }),
    ).then((handle: any) => {
        if (removed && handle?.remove) void handle.remove();
    }).catch(() => undefined);
    return () => {
        removed = true;
    };
};

export const formatBytes = (bytes: number): string => {
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let index = 0;
    while (value >= 1024 && index < units.length - 1) {
        value /= 1024;
        index += 1;
    }
    return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
};

export const isAppUpdateSupported = (): boolean => IS_ANDROID_WEBVIEW;
