import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, Loader2, Music, Upload, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { LocalSong } from '../../../types';
import {
    finalizeCustomSongs,
    pickAudioDraftsForCustomImport,
} from '../../../services/customSongImport';
import CustomSongEditorCard from './CustomSongEditorCard';

// src/components/modal/settings/ImportSongDialog.tsx
// 导入歌曲对话框：选音频 → 编辑封面/元数据/歌词 → 保存入库。

type ImportSongDialogProps = {
    isOpen: boolean;
    isDaylight: boolean;
    onClose: () => void;
};

type Phase = 'idle' | 'picking' | 'editing' | 'saving' | 'done';

const ImportSongDialog: React.FC<ImportSongDialogProps> = ({
    isOpen,
    isDaylight,
    onClose,
}) => {
    const { t } = useTranslation();
    const [phase, setPhase] = useState<Phase>('idle');
    const [songs, setSongs] = useState<LocalSong[]>([]);
    const [error, setError] = useState<string>('');

    const refresh = () => setSongs((prev) => [...prev]);

    const handlePick = async () => {
        setError('');
        setPhase('picking');
        try {
            const drafts = await pickAudioDraftsForCustomImport();
            if (drafts.length === 0) {
                setPhase('idle');
                return;
            }
            setSongs(drafts);
            setPhase('editing');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setPhase('idle');
        }
    };

    const handleSave = async () => {
        setPhase('saving');
        try {
            // 为填写了歌词的歌曲统一设置本地歌词标记。
            for (const song of songs) {
                if (song.localLyricsContent && song.localLyricsContent.trim()) {
                    song.hasLocalLyrics = true;
                    song.lyricsSource = 'local';
                }
            }
            await finalizeCustomSongs(songs);
            setPhase('done');
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
            setPhase('editing');
        }
    };

    const handleClose = () => {
        setPhase('idle');
        setSongs([]);
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
                                <Upload size={18} className="opacity-70" />
                                <h2 className={`text-base font-semibold ${textPrimary}`}>
                                    {t('options.customImportTitle', 'Import songs')}
                                </h2>
                            </div>
                            <button
                                onClick={handleClose}
                                className={`p-2 rounded-full opacity-50 hover:opacity-100 transition-colors ${isDaylight ? 'hover:bg-black/5' : 'hover:bg-white/10'}`}
                            >
                                <X size={18} />
                            </button>
                        </div>

                        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-4">
                            {phase === 'idle' && (
                                <div className="text-center py-10">
                    <div className={`mx-auto mb-5 h-16 w-16 rounded-full flex items-center justify-center ${isDaylight ? 'bg-black/5' : 'bg-white/10'}`}>
                        <Music size={26} className="opacity-50" />
                    </div>
                    <button
                        onClick={handlePick}
                        className="rounded-full bg-blue-500 hover:bg-blue-600 text-white px-6 py-2.5 text-sm font-medium transition-colors"
                    >
                        {t('options.customImportPickAudio', 'Select audio files')}
                    </button>
                    {error && <div className="mt-4 text-sm text-red-500">{error}</div>}
                </div>
            )}

            {phase === 'picking' && (
                <div className="text-center py-14">
                    <Loader2 size={28} className="animate-spin mx-auto mb-3 opacity-60" />
                    <div className="text-sm opacity-60">
                        {t('options.customImportPicking', 'Reading selected audio…')}
                    </div>
                </div>
            )}

            {(phase === 'editing' || phase === 'saving') && (
                <>
                    <div className="text-xs opacity-50">
                        {t('options.customImportCount', { count: songs.length })}
                    </div>
                    {songs.map((song) => (
                        <CustomSongEditorCard
                            key={song.id}
                            song={song}
                            isDaylight={isDaylight}
                            onChanged={refresh}
                        />
                    ))}
                    {error && <div className="text-sm text-red-500">{error}</div>}
                </>
            )}

            {phase === 'done' && (
                <div className="text-center py-14">
                    <CheckCircle2 size={40} className="mx-auto mb-3 text-green-500" />
                    <div className="text-sm font-medium">
                        {t('options.customImportDone', 'Imported to local library')}
                    </div>
                    <div className="text-xs opacity-50 mt-1">
                        {t('options.customImportDoneHint', 'Find them in the local music tab')}
                    </div>
                </div>
            )}
        </div>

        {(phase === 'editing' || phase === 'saving' || phase === 'done') && (
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
                            onClick={handleSave}
                            disabled={phase === 'saving'}
                            className="flex-1 rounded-full bg-blue-500 hover:bg-blue-600 text-white py-2.5 text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
                        >
                            {phase === 'saving' && <Loader2 size={14} className="animate-spin" />}
                            {t('options.customImportSave', 'Save to library')}
                        </button>
                    </>
                )}
            </div>
        )}
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
};

export default ImportSongDialog;
