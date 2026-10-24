import {
    DEFAULT_AUDIO_EFFECT_SETTINGS,
    normalizeAudioEffects,
    type AudioEffectSettings,
} from '../../utils/audioEffects';
import { createBitCrushCurve, createSaturationCurve } from './effectSources';
import { createNoiseBranch } from './noiseBranch';
import { createReverbBranch } from './reverbBranch';
import { createWowBranch } from './wowBranch';
import { dbToLinear, rampParam } from './effectParams';
import { connectAudioEffectNodes, createAudioEffectNodes, disconnectAudioEffectNodes, type AudioEffectNodes } from './effectNodes';

// src/services/audioEffects/effectChain.ts
// Owns the post-EQ effect chain: cutoff filters, saturation, bit crush, wow/flutter,
// vinyl noise, stereo width, dynamics and reverb, without routing audio through React.

type CreateAudioEffectChainParams = {
    context: AudioContext;
    input: AudioNode;
    output: AudioNode;
    effects: AudioEffectSettings;
    enabled: boolean;
};

export type AudioEffectChain = {
    apply: (effects: AudioEffectSettings, enabled: boolean) => void;
    dispose: () => void;
};

// Creates the effect chain between two existing nodes and returns a handle for later updates.
//
// While the chain is OFF the nodes do not exist at all: audio goes input -> output directly.
// Upstream kept the entire chain (4x-oversampled WaveShaper, compressor, delay, stereo matrix,
// reverb/noise/wow branches) allocated and connected even with every stage neutral, which kept the
// WebView audio thread busy on Android and caused playback to underrun - stutter and crackle. The
// chain is now created lazily the first time it is switched on, and torn down when switched off;
// the effects themselves are unchanged, so the feature set and sound are identical.
export const createAudioEffectChain = ({
    context,
    input,
    output,
    effects,
    enabled,
}: CreateAudioEffectChainParams): AudioEffectChain => {
    let nodes: AudioEffectNodes | null = null;
    let reverb: ReturnType<typeof createReverbBranch> | null = null;
    let noise: ReturnType<typeof createNoiseBranch> | null = null;
    let wow: ReturnType<typeof createWowBranch> | null = null;
    let lastDrive = -1;
    let lastCrush = -1;

    // Builds the real chain and applies whatever the current settings are onto it.
    const ensureConnected = (settings: AudioEffectSettings) => {
        if (nodes) return;
        nodes = createAudioEffectNodes(context);
        connectAudioEffectNodes(nodes, input, output);
        reverb = createReverbBranch(context, nodes);
        noise = createNoiseBranch(context, nodes);
        wow = createWowBranch(context, nodes);
        lastDrive = -1;
        lastCrush = -1;
        applyParameters(settings);
    };

    const disconnect = () => {
        if (!nodes) return;
        try { wow?.dispose(); } catch { /* context may be gone */ }
        try { noise?.dispose(); } catch { /* context may be gone */ }
        try { reverb?.dispose(); } catch { /* context may be gone */ }
        disconnectAudioEffectNodes(nodes, input);
        nodes = null;
        reverb = noise = wow = null;
    };

    // Maps normalized settings onto every stage of a LIVE chain.
    const applyParameters = (active: AudioEffectSettings) => {
        if (!nodes) return;
        rampParam(context, nodes.highpass.frequency, active.highpass);
        rampParam(context, nodes.lowpass.frequency, Math.min(active.lowpass, context.sampleRate * 0.475));

        if (active.drive !== lastDrive) {
            lastDrive = active.drive;
            nodes.drive.curve = createSaturationCurve(active.drive);
        }
        if (active.crush !== lastCrush) {
            lastCrush = active.crush;
            nodes.crush.curve = createBitCrushCurve(active.crush);
        }

        wow?.set(active.wow);
        noise?.set(active.noise);
        reverb?.set(active.space);

        const direct = (1 + active.width) / 2;
        const cross = (1 - active.width) / 2;
        rampParam(context, nodes.leftDirect.gain, direct);
        rampParam(context, nodes.rightDirect.gain, direct);
        rampParam(context, nodes.leftCross.gain, cross);
        rampParam(context, nodes.rightCross.gain, cross);

        rampParam(context, nodes.compressor.threshold, -6 - active.punch * 26);
        rampParam(context, nodes.compressor.ratio, 1 + active.punch * 7);
        rampParam(context, nodes.compressor.knee, 30 - active.punch * 18);
        // Compression pulls peaks down, so the makeup stage gives that headroom back.
        // Saturation needs no term here: its transfer curve is already loudness matched.
        rampParam(context, nodes.makeup.gain, dbToLinear(active.punch * 3));
    };

    // Bypass while off: input feeds output directly, no nodes exist.
    if (!enabled) {
        input.connect(output);
    } else {
        ensureConnected(normalizeAudioEffects(effects));
    }

    const apply = (nextEffects: AudioEffectSettings, nextEnabled: boolean) => {
        const active = nextEnabled ? normalizeAudioEffects(nextEffects) : DEFAULT_AUDIO_EFFECT_SETTINGS;
        if (nextEnabled && !nodes) {
            // Off -> on: build the chain now.
            input.disconnect(output);
            ensureConnected(active);
        } else if (!nextEnabled && nodes) {
            // On -> off: tear the chain down and go back to bypass.
            disconnect();
            input.connect(output);
        } else if (nodes) {
            applyParameters(active);
        }
        // Off and already bypassed: nothing to do, the sound stays direct.
    };

    return {
        apply,
        dispose: () => {
            disconnect();
            try { input.disconnect(output); } catch { /* context may be gone */ }
        },
    };
};
