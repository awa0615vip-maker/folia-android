import React, { useMemo, useState } from 'react';
import { Image as ImageIcon, Loader2, Music, Trash2, Upload, FileText } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { LocalSong } from '../../../types';
import { getLocalCoverAssetUrl } from '../../../services/localCoverAssetUrl';
import {
    applyCoverDataUrl,
    pickCoverImageDataUrl,
    pickLyricFileContent,
} from '../../../services/customSongImport';

// src/components/modal/settings/CustomSongEditorCard.tsx
// 单首歌曲的元数据编辑卡片：标题/艺术家/专辑/作曲/编曲/曲目/封面/歌词。

type CustomSongEditorCardProps = {
    isDaylight: boolean;
    song: LocalSong;
    /** 任何修改后调用，让父组件刷新列表。 */
    onChanged: () => void;
};

const fieldClass = (isDaylight: boolean) =>
    `w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors ${
        isDaylight
            ? 'border-black/10 bg-white/60 text-zinc-900 focus:border-black/25'
            : 'border-white/10 bg-black/40 text-white focus:border-white/25'
    }`;

const labelClass = 'block text-xs opacity-60 mb-1';

const CustomSongEditorCard: React.FC<CustomSongEditorCardProps> = ({
    isDaylight,
    song,
    onChanged,
}) => {
    const { t } = useTranslation();
    const [busy, setBusy] = useState<'cover' | 'lyric' | null>(null);
    const coverUrl = useMemo(
        () => getLocalCoverAssetUrl(song.localCoverAssetId, 512),
        [song.localCoverAssetId],
    );
    const artistText = song.importedMetadata.artistNames.join(', ');
    const albumText = song.importedMetadata.albumName || '';
    const lyricsText = song.localLyricsContent || song.embeddedLyricsContent || '';

    const update = (mutator: () => void) => {
        mutator();
        onChanged();
    };

    const handlePickCover = async () => {
        setBusy('cover');
        try {
            const dataUrl = await pickCoverImageDataUrl();
            if (dataUrl) {
                await applyCoverDataUrl(song, dataUrl);
                onChanged();
            }
        } catch (error) {
            console.warn('[CustomSongEditor] pick cover failed', error);
        } finally {
            setBusy(null);
        }
    };

    const handlePickLyric = async () => {
        setBusy('lyric');
        try {
            const result = await pickLyricFileContent();
            if (result.content) {
                song.localLyricsContent = result.content;
                onChanged();
            }
        } catch (error) {
            console.warn('[CustomSongEditor] pick lyric failed', error);
        } finally {
            setBusy(null);
        }
    };

    return (
        <div
            className={`rounded-2xl border p-4 space-y-4 ${
                isDaylight ? 'border-black/10 bg-black/[0.03]' : 'border-white/10 bg-white/[0.03]'
            }`}
        >
            <div className="flex items-center gap-3">
                <div
                    className={`h-16 w-16 shrink-0 overflow-hidden rounded-xl flex items-center justify-center ${
                        isDaylight ? 'bg-black/5' : 'bg-white/10'
                    }`}
                >
                    {coverUrl ? (
                        <img src={coverUrl} alt={song.title} className="h-full w-full object-cover" />
                    ) : (
                        <Music size={22} className="opacity-40" />
                    )}
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                    <div className="text-sm font-medium truncate">{song.title}</div>
                    <div className="text-xs opacity-50 truncate">{song.fileName}</div>
                </div>
                <div className="flex flex-col gap-1.5">
                    <button
                        type="button"
                        onClick={handlePickCover}
                        disabled={busy !== null}
                        className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                            isDaylight
                                ? 'bg-black/5 hover:bg-black/10 text-zinc-800'
                                : 'bg-white/10 hover:bg-white/15 text-white'
                        } disabled:opacity-40`}
                    >
                        {busy === 'cover' ? (
                            <Loader2 size={12} className="animate-spin" />
                        ) : (
                            <ImageIcon size={12} />
                        )}
                        {t('options.customImportPickCover', 'Cover')}
                    </button>
                    {song.localCoverAssetId && (
                        <button
                            type="button"
                            onClick={() =>
                                update(() => {
                                    song.localCoverAssetId = undefined;
                                    song.localCoverSource = undefined;
                                })
                            }
                            className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs transition-colors ${
                                isDaylight
                                    ? 'bg-black/5 hover:bg-black/10 text-zinc-800'
                                    : 'bg-white/10 hover:bg-white/15 text-white'
                            }`}
                        >
                            <Trash2 size={12} />
                            {t('options.customImportRemoveCover', 'Remove')}
                        </button>
                    )}
                </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
                <label className="col-span-2">
                    <span className={labelClass}>{t('options.customImportTitle', 'Title')}</span>
                    <input
                        className={fieldClass(isDaylight)}
                        value={song.title}
                        onChange={(e) => update(() => { song.title = e.target.value; })}
                    />
                </label>
                <label>
                    <span className={labelClass}>{t('options.customImportArtist', 'Artist')}</span>
                    <input
                        className={fieldClass(isDaylight)}
                        value={artistText}
                        onChange={(e) => update(() => {
                            song.importedMetadata.artistNames = e.target.value
                                .split(/[,,、]/)
                                .map((s) => s.trim())
                                .filter(Boolean);
                        })}
                    />
                </label>
                <label>
                    <span className={labelClass}>{t('options.customImportAlbum', 'Album')}</span>
                    <input
                        className={fieldClass(isDaylight)}
                        value={albumText}
                        onChange={(e) => update(() => {
                            song.importedMetadata.albumName = e.target.value || undefined;
                        })}
                    />
                </label>
                <label>
                    <span className={labelClass}>{t('options.customImportComposer', 'Composer')}</span>
                    <input
                        className={fieldClass(isDaylight)}
                        value={song.composer || ''}
                        onChange={(e) => update(() => { song.composer = e.target.value || undefined; })}
                    />
                </label>
                <label>
                    <span className={labelClass}>{t('options.customImportArranger', 'Arranger')}</span>
                    <input
                        className={fieldClass(isDaylight)}
                        value={song.arranger || ''}
                        onChange={(e) => update(() => { song.arranger = e.target.value || undefined; })}
                    />
                </label>
                <label>
                    <span className={labelClass}>{t('options.customImportTrackNumber', 'Track #')}</span>
                    <input
                        className={fieldClass(isDaylight)}
                        inputMode="numeric"
                        value={song.trackNumber ?? ''}
                        onChange={(e) => update(() => {
                            const digits = e.target.value.replace(/\D/g, '');
                            song.trackNumber = digits ? Number(digits) : undefined;
                        })}
                    />
                </label>
                <label>
                    <span className={labelClass}>{t('options.customImportDiscNumber', 'Disc #')}</span>
                    <input
                        className={fieldClass(isDaylight)}
                        inputMode="numeric"
                        value={song.discNumber ?? ''}
                        onChange={(e) => update(() => {
                            const digits = e.target.value.replace(/\D/g, '');
                            song.discNumber = digits ? Number(digits) : undefined;
                        })}
                    />
                </label>
            </div>

            <div>
                <div className="flex items-center justify-between mb-1">
                    <span className="text-xs opacity-60">
                        {t('options.customImportLyrics', 'Lyrics')}
                    </span>
                    <button
                        type="button"
                        onClick={handlePickLyric}
                        disabled={busy !== null}
                        className={`flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs transition-colors ${
                            isDaylight
                                ? 'bg-black/5 hover:bg-black/10 text-zinc-800'
                                : 'bg-white/10 hover:bg-white/15 text-white'
                        } disabled:opacity-40`}
                    >
                        {busy === 'lyric' ? (
                            <Loader2 size={12} className="animate-spin" />
                        ) : (
                            <FileText size={12} />
                        )}
                        {t('options.customImportPickLyric', 'Lyric file')}
                    </button>
                </div>
                <textarea
                    className={`${fieldClass(isDaylight)} h-28 resize-y font-mono text-xs leading-relaxed`}
                    placeholder={t('options.customImportLyricsPlaceholder', 'Paste lyrics here, or pick a .lrc file')}
                    value={lyricsText}
                    onChange={(e) => update(() => {
                        song.localLyricsContent = e.target.value;
                    })}
                />
            </div>
        </div>
    );
};

export default CustomSongEditorCard;
