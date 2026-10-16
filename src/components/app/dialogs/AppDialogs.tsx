import React from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence } from 'framer-motion';
import LyricMatchModal from '../../modal/LyricMatchModal';
import NaviLyricMatchModal from '../../modal/NaviLyricMatchModal';
import OnlineLyricMatchModal from '../../modal/OnlineLyricMatchModal';
import UnavailableReplacementDialog from '../../modal/UnavailableReplacementDialog';
// 性能：设置面板体量大（SettingsModal 及其全部子视图），只在用户打开设置时才加载，避免进入首屏闭包。
const SettingsModal = React.lazy(() => import('../../modal/SettingsModal'));
import ConfirmDialog from '../../shared/ConfirmDialog';
import type { AppDialogsModel } from './buildAppDialogsModel';
import { countRender } from '../../../dev/renderCount';
import StatusToast from './StatusToast';

// Centralized app-level dialog and toast renderer for the player shell.
type AppDialogsProps = {
    model: AppDialogsModel;
};

const AppDialogs: React.FC<AppDialogsProps> = ({ model }) => {
    countRender('AppDialogs');
    const { statusToast, lyricMatchDialog, naviLyricMatchDialog, onlineLyricMatchDialog, unavailableReplacementDialog, settingsDialog, wallpaperEntryConfirmDialog } = model;

    return (
        <>
            {createPortal(
                <AnimatePresence>
                    {statusToast && (
                        <StatusToast key={statusToast.toastKey} statusToast={statusToast} />
                    )}
                </AnimatePresence>,
                document.body,
            )}

            {lyricMatchDialog && <LyricMatchModal {...lyricMatchDialog} />}
            {naviLyricMatchDialog && <NaviLyricMatchModal {...naviLyricMatchDialog} />}
            {onlineLyricMatchDialog && <OnlineLyricMatchModal {...onlineLyricMatchDialog} />}
            {unavailableReplacementDialog && <UnavailableReplacementDialog {...unavailableReplacementDialog} />}
            {wallpaperEntryConfirmDialog && <ConfirmDialog {...wallpaperEntryConfirmDialog} />}
            <AnimatePresence>
                {settingsDialog && (
                    <React.Suspense fallback={null}>
                        <SettingsModal {...settingsDialog} />
                    </React.Suspense>
                )}
            </AnimatePresence>
        </>
    );
};

export default React.memo(AppDialogs);
