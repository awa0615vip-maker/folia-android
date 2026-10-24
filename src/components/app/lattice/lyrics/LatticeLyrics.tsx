import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useFontsEpoch } from '../../../../hooks/useFontsEpoch';
import { useLatticeLyrics } from './LatticeLyricsProvider';
import { useLatticeLyricCanvas } from './useLatticeLyricCanvas';
import type { LatticeTile } from '../latticeModel';
import './LatticeLyrics.css';

// src/components/app/lattice/lyrics/LatticeLyrics.tsx
// WebGL 歌词画布 + 就绪看门狗：如果 4 秒内画布没有就绪（安卓 WebView 偶发 WebGL 创建失败
// 或渲染线程挂起），强制降级为纯文本歌词行渲染，保证界面不再出现全黑、无内容可看。
const FALLBACK_DELAY_MS = 4000;

export default function LatticeLyrics({ tile, reducedMotion, reveal = true }: { tile: LatticeTile; reducedMotion: boolean; reveal?: boolean }) {
    const source = useLatticeLyrics();
    const fontsEpoch = useFontsEpoch();
    const host = useRef<HTMLDivElement>(null);
    const input = useMemo(() => source && source.songKey === tile.id
        ? { ...source, fontsEpoch, reducedMotion } : null, [source, tile.id, fontsEpoch, reducedMotion]);
    const ready = useLatticeLyricCanvas(host, input);
    const [fellBack, setFellBack] = useState(false);
    useEffect(() => {
        if (ready) return;
        const timer = window.setTimeout(() => setFellBack(true), FALLBACK_DELAY_MS);
        return () => window.clearTimeout(timer);
    }, [ready, input?.songKey]);
    const line = input?.lines[input.currentLineIndex];
    const showCanvas = ready && !fellBack;
    return <>
        <AnimatePresence initial={false}>
            <motion.span
                key={ready ? 'lyrics-ready' : 'lyrics-loading'}
                className={`lattice-poster-copy ${ready ? 'lattice-lyric-metadata' : ''}`}
                initial={{ opacity: reducedMotion ? 1 : 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: reducedMotion ? 1 : 0 }}
                transition={{ duration: reducedMotion ? 0 : 0.24, ease: 'easeInOut' }}
            >
                <strong>{tile.title}</strong><small>{tile.artist}</small>
            </motion.span>
        </AnimatePresence>
        <div className={`lattice-lyrics ${showCanvas ? 'is-ready' : ''} ${reveal ? 'is-revealed' : 'is-pending-reveal'}`}>
            <div ref={host} className="lattice-lyrics-canvas" aria-hidden="true" />
            {showCanvas && <span className="sr-only">{line?.fullText}</span>}
            {!showCanvas && fellBack && input && (
                <div className="lattice-lyrics-fallback" aria-label="歌词">
                    {input.lines.slice(0, Math.max(input.currentLineIndex + 1, 5)).map((lyricLine, index) => (
                        <span
                            key={index}
                            className={index === input.currentLineIndex ? 'is-current' : undefined}
                        >
                            {lyricLine.fullText || '♪'}
                        </span>
                    ))}
                </div>
            )}
        </div>
    </>;
}
