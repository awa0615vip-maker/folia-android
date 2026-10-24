import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw, Download, CheckCircle2, AlertTriangle } from 'lucide-react';
import { Browser } from '@capacitor/browser';
import SettingsRow from './SettingsRow';
import ThemedDialog from '../../shared/ThemedDialog';
import {
    buildDownloadUrls,
    checkForUpdate,
    formatBytes,
    getCurrentAppInfo,
    installDownloadedUpdate,
    pollDownloadProgress,
    startDownload,
    subscribeDownloadComplete,
    type UpdateInfo,
} from '../../../services/appUpdate';

// 安卓专属：显示当前版本 + 应用内检查更新（GitHub Releases），下载并调起系统安装器。
// 放在“图形设置”页底部，仅安卓 WebView 渲染。

const ACCENT_COLOR = 'var(--text-accent)';

type DialogState = 'closed' | 'info' | 'downloading' | 'done' | 'failed';

type AndroidUpdateSectionProps = {
    settingsCardClass: string;
    dividerClass: string;
    utilityGhostButtonClass: string;
};

const RELEASE_PAGE_URL = 'https://github.com/awa0615vip-maker/folia-android/releases/latest';

const AndroidUpdateSection: React.FC<AndroidUpdateSectionProps> = ({
    settingsCardClass,
    dividerClass,
    utilityGhostButtonClass,
}) => {
    const [versionName, setVersionName] = useState<string>('');
    const [versionCode, setVersionCode] = useState<number | null>(null);
    const [checking, setChecking] = useState(false);
    const [hint, setHint] = useState<string>('');
    const [dialogState, setDialogState] = useState<DialogState>('closed');
    const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
    const [progress, setProgress] = useState(0);
    const [progressText, setProgressText] = useState('');
    const [needPermission, setNeedPermission] = useState(false);
    const [errorText, setErrorText] = useState('');

    const urlsRef = useRef<string[]>([]);
    const urlIndexRef = useRef(0);
    const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const activeDownloadIdRef = useRef<number | null>(null);
    const finishedRef = useRef(false);

    const clearPoll = useCallback(() => {
        if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
        }
    }, []);

    const loadCurrentVersion = useCallback(() => {
        getCurrentAppInfo()
            .then((info) => {
                setVersionName(info.versionName);
                setVersionCode(info.versionCode);
            })
            .catch(() => undefined);
    }, []);

    useEffect(() => {
        loadCurrentVersion();
        const unsubscribe = subscribeDownloadComplete((event) => {
            if (event.success) {
                finishedRef.current = true;
                clearPoll();
                setProgress(100);
                setNeedPermission(!event.installing);
                setDialogState('done');
            } else {
                // 自动切换到下一个下载通道（直连 → 加速镜像）。
                const nextIndex = urlIndexRef.current + 1;
                if (nextIndex < urlsRef.current.length) {
                    urlIndexRef.current = nextIndex;
                    setProgressText('直连失败，正在切换加速通道…');
                    void runDownload(nextIndex);
                } else {
                    finishedRef.current = true;
                    clearPoll();
                    setErrorText('下载失败，可能是网络无法访问 GitHub。可点“加速下载”重试，或到发布页手动下载。');
                    setDialogState('failed');
                }
            }
        });
        return () => {
            unsubscribe();
            clearPoll();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleCheck = async () => {
        if (checking) return;
        setChecking(true);
        setHint('正在检查更新…');
        try {
            const info = await checkForUpdate();
            if (info.hasUpdate) {
                setUpdateInfo(info);
                setHint('');
                setDialogState('info');
            } else {
                setHint(`已是最新版本（${info.latestVersionName ? `最新 ${info.latestVersionName}` : '未发现新版本'}）`);
            }
        } catch (error) {
            setHint('检查更新失败：网络无法访问 GitHub，请稍后重试');
        } finally {
            setChecking(false);
        }
    };

    const runDownload = useCallback(async (index: number) => {
        const info = updateInfo;
        if (!info) return;
        const urls = urlsRef.current.length ? urlsRef.current : buildDownloadUrls(info.apkUrl);
        urlsRef.current = urls;
        const url = urls[index];
        if (!url) {
            setErrorText('没有可用的下载地址');
            setDialogState('failed');
            return;
        }
        finishedRef.current = false;
        setNeedPermission(false);
        setErrorText('');
        setProgress(0);
        setProgressText(index === 0 ? '正在下载…（可在通知栏查看进度）' : '正在通过加速通道下载…');
        setDialogState('downloading');

        try {
            const downloadId = await startDownload(url);
            activeDownloadIdRef.current = downloadId;
            clearPoll();
            pollTimerRef.current = setInterval(() => {
                void pollDownloadProgress(downloadId).then((p) => {
                    if (p.status === 'failed') {
                        if (!finishedRef.current) {
                            const nextIndex = urlIndexRef.current + 1;
                            if (nextIndex < urlsRef.current.length) {
                                urlIndexRef.current = nextIndex;
                                setProgressText('直连失败，正在切换加速通道…');
                                void runDownload(nextIndex);
                            } else {
                                finishedRef.current = true;
                                clearPoll();
                                setErrorText('下载失败：网络无法访问 GitHub。请换网络或用“加速下载”。');
                                setDialogState('failed');
                            }
                        }
                        return;
                    }
                    if (p.status === 'successful' || p.status === 'completed') {
                        setProgress(100);
                        setProgressText('下载完成，准备安装…');
                        return;
                    }
                    if (p.total > 0) {
                        setProgress(Math.min(99, Math.round((p.downloaded / p.total) * 100)));
                        setProgressText(`正在下载… ${Math.round((p.downloaded / p.total) * 100)}%（${formatBytes(p.downloaded)}/${formatBytes(p.total)}）`);
                    } else {
                        setProgressText(`正在下载… ${formatBytes(p.downloaded)}`);
                    }
                }).catch(() => undefined);
            }, 1000);
        } catch (error) {
            setErrorText('启动下载失败，请检查网络后重试。');
            setDialogState('failed');
        }
    }, [clearPoll, updateInfo]);

    const startNormal = () => {
        urlIndexRef.current = 0;
        void runDownload(0);
    };

    const startMirror = () => {
        const mirrorIndex = Math.max(1, urlsRef.current.length ? 1 : 1);
        urlIndexRef.current = mirrorIndex;
        if (updateInfo) {
            urlsRef.current = buildDownloadUrls(updateInfo.apkUrl);
        }
        void runDownload(urlsRef.current.length > 1 ? 1 : 0);
    };

    const openReleasePage = () => {
        Browser.open({ url: RELEASE_PAGE_URL }).catch(() => undefined);
    };

    const closeDialog = () => {
        clearPoll();
        setDialogState('closed');
    };

    return (
        <div className={`rounded-xl border overflow-hidden ${settingsCardClass}`}>
            <SettingsRow
                title="应用更新"
                description={
                    versionName
                        ? `当前版本 ${versionName}${versionCode != null ? `（构建 ${versionCode}）` : ''}${hint ? ` · ${hint}` : ''}`
                        : (hint || '正在读取版本信息…')
                }
                dividerClass={dividerClass}
                isLast
                control={(
                    <button
                        type="button"
                        onClick={handleCheck}
                        disabled={checking}
                        className="inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50"
                        style={{
                            borderColor: ACCENT_COLOR,
                            color: ACCENT_COLOR,
                        }}
                    >
                        <RefreshCw size={13} className={checking ? 'animate-spin' : ''} />
                        检查更新
                    </button>
                )}
            />

            <ThemedDialog
                isOpen={dialogState !== 'closed'}
                onClose={closeDialog}
                isDaylight={false}
                title={
                    dialogState === 'info' ? '发现新版本'
                        : dialogState === 'downloading' ? '下载更新'
                        : dialogState === 'done' ? '下载完成'
                        : '更新失败'
                }
                footer={(
                    <>
                        {dialogState === 'info' && (
                            <>
                                <button
                                    type="button"
                                    onClick={closeDialog}
                                    className={`rounded-xl border px-4 py-2 text-sm font-medium ${utilityGhostButtonClass}`}
                                    style={{ color: 'var(--text-primary)' }}
                                >
                                    稍后
                                </button>
                                {updateInfo?.apkUrl && (
                                    <button
                                        type="button"
                                        onClick={startMirror}
                                        className={`rounded-xl border px-4 py-2 text-sm font-medium ${utilityGhostButtonClass}`}
                                        style={{ color: 'var(--text-primary)' }}
                                    >
                                        加速下载
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={startNormal}
                                    disabled={!updateInfo?.apkUrl}
                                    className="rounded-xl px-4 py-2 text-sm font-semibold text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                                    style={{ backgroundColor: ACCENT_COLOR }}
                                >
                                    立即下载
                                </button>
                            </>
                        )}
                        {dialogState === 'downloading' && (
                            <button
                                type="button"
                                onClick={closeDialog}
                                className={`rounded-xl border px-4 py-2 text-sm font-medium ${utilityGhostButtonClass}`}
                                style={{ color: 'var(--text-primary)' }}
                            >
                                后台下载
                            </button>
                        )}
                        {dialogState === 'done' && (
                            <>
                                {needPermission && (
                                    <button
                                        type="button"
                                        onClick={() => {
                                            void installDownloadedUpdate().then((ok) => {
                                                if (ok) setNeedPermission(false);
                                            });
                                        }}
                                        className="rounded-xl px-4 py-2 text-sm font-semibold text-white"
                                        style={{ backgroundColor: ACCENT_COLOR }}
                                    >
                                        重新安装
                                    </button>
                                )}
                                <button
                                    type="button"
                                    onClick={closeDialog}
                                    className={`rounded-xl border px-4 py-2 text-sm font-medium ${utilityGhostButtonClass}`}
                                    style={{ color: 'var(--text-primary)' }}
                                >
                                    完成
                                </button>
                            </>
                        )}
                        {dialogState === 'failed' && (
                            <>
                                <button
                                    type="button"
                                    onClick={openReleasePage}
                                    className={`rounded-xl border px-4 py-2 text-sm font-medium ${utilityGhostButtonClass}`}
                                    style={{ color: 'var(--text-primary)' }}
                                >
                                    去发布页
                                </button>
                                <button
                                    type="button"
                                    onClick={startMirror}
                                    className="rounded-xl px-4 py-2 text-sm font-semibold text-white"
                                    style={{ backgroundColor: ACCENT_COLOR }}
                                >
                                    加速重试
                                </button>
                            </>
                        )}
                    </>
                )}
            >
                {dialogState === 'info' && updateInfo && (
                    <div className="space-y-3">
                        <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
                            新版本：{updateInfo.latestVersionName}
                            {updateInfo.sizeBytes > 0 && (
                                <span className="opacity-60" style={{ color: 'var(--text-secondary)' }}>
                                    {' '}· {formatBytes(updateInfo.sizeBytes)}
                                </span>
                            )}
                        </div>
                        <div className="text-[11px] opacity-60" style={{ color: 'var(--text-secondary)' }}>
                            当前版本：{updateInfo.currentVersionName}
                        </div>
                        <div
                            className="max-h-48 overflow-y-auto rounded-lg border p-3 text-xs leading-5 whitespace-pre-wrap"
                            style={{
                                color: 'var(--text-secondary)',
                                borderColor: 'var(--border-color, rgba(255,255,255,0.12))',
                            }}
                        >
                            {updateInfo.releaseNotes || '本次更新未提供说明。'}
                        </div>
                        <div className="text-[11px] leading-5 opacity-60" style={{ color: 'var(--text-secondary)' }}>
                            下载完成后会自动弹出系统安装器，按提示覆盖安装即可（不会丢失歌曲与设置）。
                        </div>
                    </div>
                )}

                {dialogState === 'downloading' && (
                    <div className="space-y-3 py-1">
                        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
                            <Download size={16} />
                            <span>{progressText}</span>
                        </div>
                        <div className="h-2 w-full overflow-hidden rounded-full" style={{ backgroundColor: 'rgba(128,128,128,0.2)' }}>
                            <div
                                className="h-full rounded-full transition-all duration-300"
                                style={{ width: `${progress}%`, backgroundColor: ACCENT_COLOR }}
                            />
                        </div>
                        <div className="text-[11px] leading-5 opacity-60" style={{ color: 'var(--text-secondary)' }}>
                            下载由系统下载管理器负责，可在通知栏看到进度；切到后台也会继续。
                        </div>
                    </div>
                )}

                {dialogState === 'done' && (
                    <div className="space-y-3 py-1">
                        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
                            {needPermission ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
                            <span>{needPermission ? '需要先允许安装应用' : '安装器已打开'}</span>
                        </div>
                        <div className="text-xs leading-5 opacity-70" style={{ color: 'var(--text-secondary)' }}>
                            {needPermission
                                ? '已为你打开“允许安装未知应用”设置页，请允许 Folia 安装应用，然后返回点“重新安装”。'
                                : '请在系统安装弹窗中确认覆盖安装；安装完成后打开应用，可在本页核对版本号是否已更新。'}
                        </div>
                    </div>
                )}

                {dialogState === 'failed' && (
                    <div className="space-y-3 py-1">
                        <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text-primary)' }}>
                            <AlertTriangle size={16} />
                            <span>更新失败</span>
                        </div>
                        <div className="text-xs leading-5 opacity-70" style={{ color: 'var(--text-secondary)' }}>
                            {errorText}
                        </div>
                    </div>
                )}
            </ThemedDialog>
        </div>
    );
};

export default AndroidUpdateSection;
