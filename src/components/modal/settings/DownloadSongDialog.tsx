import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, Download, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
    downloadSongToLocal,
    type DownloadSongForm,
} from '../../../services/customSongImport';

// src/components/modal/settings/DownloadSongDialog.tsx
// 下载音乐对话框：填音频直链（封面/歌词 URL 可选）→ 下载到本地并入库。

type DownloadSongDialogProps = {
    isOpen: boolean;
    isDaylight: boolean;
    onClose: () => void;
};

const emptyForm: DownloadSongForm = {
    audioUrl: '',
    title: '',
    artist: '',
    album: '',
    composer: '',
    arranger: '',
    coverUrl: '',
    lyricsUrl: '',
    lyrics: '',
};

type Phase = 'form' | 'working' | 'done';

const DownloadSongDialog: React.FC<DownloadSongDialogProps> = ({
    isOpen,
    isDaylight,
    onClose,
}) => {
    const { t } = useTranslation();
    const [form, setForm] = useState<DownloadSongForm>(emptyForm);
    const [phase, setPhase] = useState<Phase>('form');
    const [error, setError] = useState('');

    const update = (key: keyof DownloadSongForm, value: string) => {
        setForm((prev) => ({ ...prev, [key]: value }));
    };

    const fieldClass =
        `w-full rounded-lg border px-3 py-2 text-sm outline-none transition-colors ${
            isDaylight
                ? 'border-black/10 bg-white/60 text-zinc-900 focus:border-black/25'
                : 'border-white/10 bg-black/40 text-white focus:border-white/25'
        }`;
    const labelClass = 'block text-xs opacity-60 mb-1';

    const handleDownload = async () => {
        if (!form.audioUrl.trim()) {
            setError(t('options.downloadAudioUrlRequired', 'Audio URL is required'));
            return;
        }
        setError('');
        setPhase('working');
        try {
            await downloadSongToLocal({
                ...form,
                audioUrl: form.audioUrl.trim(),
                coverUrl: form.coverUrl?.trim() || '',
                lyricsUrl: form.lyricsUrl?.trim() || '',
            });
            setPhase('done');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setPhase('form');
        }
    };

    const handleClose = () => {
        setForm(emptyForm);
        setPhase('form');
        setError('');
        onClose();
    };

    const bgClass = isDaylight
        ? 'bg-white/95 border-black/10'
        : 'bg-zinc-900/95 border-white/10';
    const textPrimary = isDaylight ? 'text-zinc-900' : 'text-white';

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-xl p-4"
                    onClick={handleClose}
                >
                    <motion.div
                        initial={{ scale: 0.95, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.95, opacity: 0 }}
                        onClick={(e) => e.stopPropagation()}
                        className={`${bgClass} border rounded-3xl w-full max-w-xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden`}
                    >
                        <div className={`flex items-center justify-between px-6 py-5 border-b ${isDaylight ? 'border-black/10' : 'border-white/10'}`}>
                            <div className="flex items-center gap-2.5">
                                <Download size={18} className="opacity-70" />
                                <h2 className={`text-base font-semibold ${textPrimary}`}>
                                    {t('options.downloadTitle', 'Download music')}
                                </h2>
                            </div>
                            <button
                                onClick={handleClose}
                                className={`p-2 rounded-full opacity-50 hover:opacity-100 transition-colors ${isDaylight ? 'hover:bg-black/5' : 'hover:bg-white/10'}`}
                            >
                                <X size={18} />
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto px-6 py-5">
                            {phase === 'done' ? (
                                <div className="text-center py-14">
                                    <CheckCircle2 size={40} className="mx-auto mb-3 text-green-500" />
                                    <div className="text-sm font-medium">
                                        {t('options.downloadDone', 'Downloaded to local library')}
                                    </div>
                                    <div className="text-xs opacity-50 mt-1">
                                        {t('options.downloadDoneHint', 'Play it from the local music tab')}
                                    </div>
                                </div>
                            ) : (
                                <div className="space-y-3">
                                    <label className="block">
                                        <span className={labelClass}>
                                            {t('options.downloadAudioUrl', 'Audio URL')} *
                                        </span>
                                        <input
                                            className={fieldClass}
                                            value={form.audioUrl}
                                            placeholder="https://example.com/song.mp3"
                                            onChange={(e) => update('audioUrl', e.target.value)}
                                        />
                                    </label>
                                    <div className="grid grid-cols-2 gap-3">
                                        <label>
                                            <span className={labelClass}>{t('options.customImportTitle', 'Title')}</span>
                                            <input className={fieldClass} value={form.title} onChange={(e) => update('title', e.target.value)} />
                                        </label>
                                        <label>
                                            <span className={labelClass}>{t('options.customImportArtist', 'Artist')}</span>
                                            <input className={fieldClass} value={form.artist} onChange={(e) => update('artist', e.target.value)} />
                                        </label>
                                        <label>
                                            <span className={labelClass}>{t('options.customImportAlbum', 'Album')}</span>
                                            <input className={fieldClass} value={form.album} onChange={(e) => update('album', e.target.value)} />
                                        </label>
                                        <label>
                                            <span className={labelClass}>{t('options.customImportComposer', 'Composer')}</span>
                                            <input className={fieldClass} value={form.composer} onChange={(e) => update('composer', e.target.value)} />
                                        </label>
                                        <label>
                                            <span className={labelClass}>{t('options.customImportArranger', 'Arranger')}</span>
                                            <input className={fieldClass} value={form.arranger} onChange={(e) => update('arranger', e.target.value)} />
                                        </label>
                                    </div>
                                    <label className="block">
                                        <span className={labelClass}>{t('options.downloadCoverUrl', 'Cover URL')}</span>
                                        <input className={fieldClass} value={form.coverUrl} placeholder="https://example.com/cover.jpg" onChange={(e) => update('coverUrl', e.target.value)} />
                                    </label>
                                    <label className="block">
                                        <span className={labelClass}>{t('options.downloadLyricsUrl', 'Lyrics URL')}</span>
                                        <input className={fieldClass} value={form.lyricsUrl} placeholder="https://example.com/lyrics.lrc" onChange={(e) => update('lyricsUrl', e.target.value)} />
                                    </label>
                                    <label className="block">
                                        <span className={labelClass}>{t('options.customImportLyrics', 'Or paste lyrics')}</span>
                                        <textarea
                                            className={`${fieldClass} h-24 resize-y font-mono text-xs`}
                                            value={form.lyrics}
                                            onChange={(e) => update('lyrics', e.target.value)}
                                        />
                                    </label>
                                    {error && <div className="text-sm text-red-500">{error}</div>}
                                </div>
                            )}
                        </div>

                        <div className={`px-6 py-4 border-t flex gap-3 ${isDaylight ? 'border-black/10' : 'border-white/10'}`}>
                            {phase === 'done' ? (
                                <button
                                    onClick={handleClose}
                                    className="flex-1 rounded-full bg-blue-500 hover:bg-blue-600 text-white py-2.5 text-sm font-medium"
                                >
                                    {t('ui.close', 'Close')}
                                </button>
                            ) : (
                                <>
                                    <button
                                        onClick={handleClose}
                                        className={`flex-1 rounded-full py-2.5 text-sm font-medium border ${isDaylight ? 'border-black/10 hover:bg-black/5' : 'border-white/10 hover:bg-white/10'}`}
                                    >
                                        {t('localMusic.cancel', 'Cancel')}
                                    </button>
                                    <button
                                        onClick={handleDownload}
                                        disabled={phase === 'working'}
                                        className="flex-1 rounded-full bg-blue-500 hover:bg-blue-600 text-white py-2.5 text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
                                    >
                                        {phase === 'working' ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                                        {t('options.downloadStart', 'Download')}
                                    </button>
                                </>
                            )}
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default DownloadSongDialog;
