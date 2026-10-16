import React, { useState } from 'react';
import { Download, Music, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SettingsAnchor } from './navigation/SettingsAnchorContext';
import SettingsSectionHeading from './navigation/SettingsSectionHeading';
import ImportSongDialog from './ImportSongDialog';
import DownloadSongDialog from './DownloadSongDialog';

// src/components/modal/settings/LocalMusicImportDownloadSection.tsx
// 存储页顶部：导入歌曲（可编辑封面/元数据/歌词）与下载音乐到本地。

type LocalMusicImportDownloadSectionProps = {
    isDaylight: boolean;
    settingsCardClass: string;
};

const LocalMusicImportDownloadSection: React.FC<LocalMusicImportDownloadSectionProps> = ({
    isDaylight,
    settingsCardClass,
}) => {
    const { t } = useTranslation();
    const [importOpen, setImportOpen] = useState(false);
    const [downloadOpen, setDownloadOpen] = useState(false);

    const actionCard = (
        icon: React.ElementType,
        title: string,
        desc: string,
        onClick: () => void,
    ) => (
        <button
            type="button"
            onClick={onClick}
            className={`flex items-center gap-3 rounded-xl border p-4 text-left transition-colors ${
                isDaylight
                    ? 'border-black/10 bg-black/[0.03] hover:bg-black/[0.06]'
                    : 'border-white/10 bg-white/[0.03] hover:bg-white/[0.07]'
            }`}
        >
            <div
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-lg ${
                    isDaylight ? 'bg-black/5' : 'bg-white/10'
                }`}
            >
                {React.createElement(icon, { size: 18, className: 'opacity-70' })}
            </div>
            <div className="min-w-0">
                <div className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                    {title}
                </div>
                <div className="text-xs opacity-50 mt-0.5 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                    {desc}
                </div>
            </div>
        </button>
    );

    return (
        <SettingsAnchor anchorId="localMusicImport" label={t('options.localMusicImport') || 'Import & Download'}>
            <SettingsSectionHeading
                icon={Music}
                label={t('options.localMusicImport') || 'Import & Download'}
            />
            <div className={`grid grid-cols-1 sm:grid-cols-2 gap-3 rounded-xl border p-4 ${settingsCardClass}`}>
                {actionCard(
                    Upload,
                    t('options.customImportTitle', 'Import songs'),
                    t('options.customImportDesc', 'Pick audio, add cover, metadata and lyrics'),
                    () => setImportOpen(true),
                )}
                {actionCard(
                    Download,
                    t('options.downloadTitle', 'Download music'),
                    t('options.downloadDesc', 'Download from a URL, with cover and lyrics'),
                    () => setDownloadOpen(true),
                )}
            </div>

            <ImportSongDialog
                isOpen={importOpen}
                isDaylight={isDaylight}
                onClose={() => setImportOpen(false)}
            />
            <DownloadSongDialog
                isOpen={downloadOpen}
                isDaylight={isDaylight}
                onClose={() => setDownloadOpen(false)}
            />
        </SettingsAnchor>
    );
};

export default LocalMusicImportDownloadSection;
