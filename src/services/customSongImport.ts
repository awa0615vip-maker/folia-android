// src/services/customSongImport.ts
// 自定义导入 / 下载音乐的前端服务层。
//
// 负责：
//   - 选择音频文件并解析内嵌元数据（不立即保存，返回草稿供编辑）
//   - 选择封面图 / 歌词文件
//   - 将封面、歌词写入本地库
//   - 从 URL 下载音频、封面、歌词到本地并入库
//
// 说明：本服务不内置任何盗版音源，只做“用户给的本地文件 / 直链”的通用导入与下载。

import type { LocalSong } from '../types';
import { saveLocalSongs } from './db';
import {
    buildImportedMetadataSnapshot,
} from '../utils/localSongMetadata';
import { parseEmbeddedMetadataAsync } from '../utils/localMetadataWorkerClient';
import { prepareLocalCoverBlob } from './localCoverAssetService';
import { LOCAL_MUSIC_UPDATED_EVENT } from './localMusicService';

type NativeTrack = {
    id: string;
    fileName: string;
    title?: string;
    artist?: string;
    album?: string;
    duration?: number;
    fileSize?: number;
    mimeType?: string;
    url: string;
};

type NativePlugin = {
    pickAudioFiles?: () => Promise<{
        tracks?: NativeTrack[];
        port?: number;
        cancelled?: boolean;
        picked?: number;
        copied?: number;
    }>;
    pickCoverImage?: () => Promise<{
        dataUrl?: string;
        size?: number;
        mime?: string;
        cancelled?: boolean;
    }>;
    pickLyricFile?: () => Promise<{
        content?: string;
        fileName?: string;
        cancelled?: boolean;
    }>;
    downloadToLibrary?: (options: {
        audioUrl: string;
        coverUrl?: string;
        lyricsUrl?: string;
    }) => Promise<{
        audioRef?: string;
        audioUrl?: string;
        fileSize?: number;
        mime?: string;
        coverDataUrl?: string;
        lyricsText?: string;
        port?: number;
    }>;
};

const getPlugin = (): NativePlugin | null => (
    (window as any).Capacitor?.Plugins?.FoliaNative ?? null
);

const titleFromFileName = (fileName: string): string => (
    String(fileName || 'Unknown Song').replace(/\.[^.]+$/, '')
);

/** data: URL → Blob。 */
export const dataUrlToBlob = (dataUrl: string): Blob => {
    const [header, base64] = dataUrl.split(',');
    const mimeMatch = /data:([^;]+);base64/.exec(header);
    const mime = mimeMatch?.[1] || 'image/jpeg';
    const binary = atob(base64 || '');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
};

// ===== 选择音频，返回草稿（不保存） =====

/**
 * 选择一个或多个音频文件，原生侧复制到私有目录；这里解析内嵌元数据并返回草稿，
 * 交由编辑器补全信息后再保存。
 */
export const pickAudioDraftsForCustomImport = async (): Promise<LocalSong[]> => {
    const plugin = getPlugin();
    if (!plugin?.pickAudioFiles) {
        throw new Error('Audio picker is unavailable');
    }
    const response = await plugin.pickAudioFiles();
    if (response.cancelled) return [];

    const songs: LocalSong[] = [];
    for (const track of response.tracks || []) {
        const fileName = track.fileName || `track-${track.id}`;
        const fallbackTitle = titleFromFileName(fileName);
        let metadata: Awaited<ReturnType<typeof parseEmbeddedMetadataAsync>> = null;
        try {
            const blob = await (await fetch(track.url)).blob();
            metadata = await parseEmbeddedMetadataAsync(
                new File([blob], fileName, { type: track.mimeType || 'audio/*' }),
                true,
            );
        } catch (error) {
            console.warn('[CustomImport] metadata parse failed', fileName, error);
        }

        const title = metadata?.title || fallbackTitle;
        const song: LocalSong = {
            id: `android-imported-${track.id}`,
            fileName,
            filePath: `Android/Imported/${track.id}`,
            nativeAudioRef: track.id,
            nativeAudioUrl: track.url,
            duration: Number(metadata?.duration) || Number(track.duration) || 0,
            fileSize: Number(track.fileSize) || 0,
            fileLastModified: Date.now(),
            mimeType: track.mimeType || 'audio/*',
            addedAt: Date.now(),
            title,
            titleOrigin: 'import',
            importedMetadata: buildImportedMetadataSnapshot({
                fileName,
                embeddedTitle: metadata?.title,
                fallbackTitle,
                embeddedArtist: metadata?.artist,
                embeddedArtists: metadata?.artists,
                fallbackArtist: track.artist || '',
                embeddedAlbum: metadata?.album,
                fallbackAlbum: track.album || '',
            }),
            trackNumber: metadata?.trackNumber,
            discNumber: metadata?.discNumber,
            folderName: 'Android 自定义导入',
            hasManualLyricSelection: false,
            // 自定义导入后不自动匹配，避免在线数据覆盖用户手工填写的信息。
            noAutoMatch: true,
        };

        if (metadata?.cover) {
            const prepared = await prepareLocalCoverBlob(metadata.cover);
            if (prepared?.assetId) {
                song.localCoverAssetId = prepared.assetId;
                song.localCoverSource = 'embedded';
            }
        }
        if (metadata?.lyrics) {
            song.hasEmbeddedLyrics = true;
            song.embeddedLyricsContent = metadata.lyrics;
            if (metadata.translationLyrics) {
                song.hasEmbeddedTranslationLyrics = true;
                song.embeddedTranslationLyricsContent = metadata.translationLyrics;
            }
        }
        songs.push(song);
    }
    return songs;
};

// ===== 选择封面 / 歌词 =====

/** 打开系统图片选择器，返回封面的 data: URL；用户取消时返回空串。 */
export const pickCoverImageDataUrl = async (): Promise<string> => {
    const plugin = getPlugin();
    if (!plugin?.pickCoverImage) {
        throw new Error('Cover picker is unavailable');
    }
    const result = await plugin.pickCoverImage();
    if (result.cancelled || !result.dataUrl) return '';
    return result.dataUrl;
};

/** 打开系统文件选择器选歌词文件，返回 { fileName, content }；取消返回空 content。 */
export const pickLyricFileContent = async (): Promise<{ fileName: string; content: string }> => {
    const plugin = getPlugin();
    if (!plugin?.pickLyricFile) {
        throw new Error('Lyric picker is unavailable');
    }
    const result = await plugin.pickLyricFile();
    if (result.cancelled) return { fileName: '', content: '' };
    return { fileName: result.fileName || '', content: result.content || '' };
};

/** 用 data: URL 封面替换歌曲封面。 */
export const applyCoverDataUrl = async (song: LocalSong, dataUrl: string): Promise<boolean> => {
    if (!dataUrl) return false;
    const blob = dataUrlToBlob(dataUrl);
    const prepared = await prepareLocalCoverBlob(blob);
    if (!prepared?.assetId) return false;
    song.localCoverAssetId = prepared.assetId;
    song.localCoverSource = 'manual';
    return true;
};

/** 给歌曲写入歌词文本（.lrc/纯文本等都可）。 */
export const applyUserLyrics = (song: LocalSong, lyricsText: string): void => {
    const text = lyricsText.trim();
    if (!text) return;
    song.hasLocalLyrics = true;
    song.localLyricsContent = text;
    song.lyricsSource = 'local';
};

/** 读取音频时长（毫秒），失败/超时返回 0。 */
export const readAudioDurationMs = (url: string): Promise<number> => new Promise((resolve) => {
    try {
        const element = new Audio();
        element.preload = 'metadata';
        let settled = false;
        const finish = (value: number) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };
        element.onloadedmetadata = () => {
            finish(Number.isFinite(element.duration) ? element.duration * 1000 : 0);
        };
        element.onerror = () => finish(0);
        element.src = url;
        setTimeout(() => finish(0), 10000);
    } catch {
        resolve(0);
    }
});

// ===== 保存 =====

/** 最终保存自定义导入的歌曲。 */
export const finalizeCustomSongs = async (songs: LocalSong[]): Promise<void> => {
    if (songs.length === 0) return;
    await saveLocalSongs(songs);
    window.dispatchEvent(new CustomEvent(LOCAL_MUSIC_UPDATED_EVENT));
};

// ===== 下载 =====

export type DownloadSongForm = {
    audioUrl: string;
    title?: string;
    artist?: string;
    album?: string;
    composer?: string;
    arranger?: string;
    coverUrl?: string;
    lyricsUrl?: string;
    /** 直接粘贴的歌词（lyricsUrl 为空时使用）。 */
    lyrics?: string;
};

/** 从 URL 下载音乐到本地并入库，包含封面、歌词。 */
export const downloadSongToLocal = async (form: DownloadSongForm): Promise<LocalSong> => {
    const plugin = getPlugin();
    if (!plugin?.downloadToLibrary) {
        throw new Error('Download is unavailable');
    }
    const result = await plugin.downloadToLibrary({
        audioUrl: form.audioUrl,
        coverUrl: form.coverUrl || '',
        lyricsUrl: form.lyricsUrl || '',
    });
    if (!result.audioRef || !result.audioUrl) {
        throw new Error('Download produced no audio');
    }

    const audioRef = result.audioRef;
    const duration = await readAudioDurationMs(result.audioUrl);
    const now = Date.now();
    const ext = audioRef.includes('.') ? audioRef.slice(audioRef.lastIndexOf('.')) : '.mp3';
    const title = form.title?.trim() || titleFromFileName(audioRef);

    const song: LocalSong = {
        id: `android-imported-${audioRef}`,
        fileName: `${title}${ext}`,
        filePath: `Android/Imported/${audioRef}`,
        nativeAudioRef: audioRef,
        nativeAudioUrl: result.audioUrl,
        duration,
        fileSize: Number(result.fileSize) || 0,
        fileLastModified: now,
        mimeType: result.mime || 'audio/mpeg',
        addedAt: now,
        title,
        titleOrigin: 'manual-match',
        importedMetadata: buildImportedMetadataSnapshot({
            fileName: `${title}${ext}`,
            embeddedTitle: form.title,
            fallbackTitle: title,
            embeddedArtist: form.artist,
            embeddedAlbum: form.album,
        }),
        composer: form.composer || undefined,
        arranger: form.arranger || undefined,
        folderName: 'Android 下载音乐',
        hasManualLyricSelection: false,
        noAutoMatch: true,
    };

    if (result.coverDataUrl) {
        await applyCoverDataUrl(song, result.coverDataUrl);
    }
    const lyricsText = result.lyricsText || form.lyrics || '';
    if (lyricsText.trim()) {
        applyUserLyrics(song, lyricsText);
    }

    await saveLocalSongs([song]);
    window.dispatchEvent(new CustomEvent(LOCAL_MUSIC_UPDATED_EVENT));
    return song;
};
