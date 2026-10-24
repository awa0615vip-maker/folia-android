package top.izuna.foliamajor;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.content.Intent;
import android.net.wifi.WifiManager;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaMetadata;
import android.media.MediaPlayer;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import androidx.annotation.Nullable;

import java.io.InputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.ResponseBody;

public class FoliaPlaybackService extends Service {
    private static final String CHANNEL_ID = "folia_playback";
    private static final int NOTIFICATION_ID = 31009;
    private MediaSession mediaSession;
    private final ExecutorService artworkExecutor = Executors.newSingleThreadExecutor();
    // 整曲下载线程：与封面加载分离，避免下载阻塞封面或相互排队。
    private final ExecutorService downloadExecutor = Executors.newSingleThreadExecutor();
    private final OkHttpClient artworkClient = new OkHttpClient();
    // 歌曲整曲下载用：更大的超时窗口，播放前的整曲落盘。
    private final OkHttpClient audioClient = new OkHttpClient.Builder()
        .connectTimeout(30, java.util.concurrent.TimeUnit.SECONDS)
        .readTimeout(120, java.util.concurrent.TimeUnit.SECONDS)
        .build();
    private final Map<String, Bitmap> artworkCache = new ConcurrentHashMap<>();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private volatile String currentArtworkUrl = "";
    private volatile String appliedArtworkUrl = "";
    private volatile Bitmap appliedArtworkBitmap = null;
    private volatile String lastRequestedCoverUrl = "";
    private PowerManager.WakeLock wakeLock;
    private WifiManager.WifiLock wifiLock;
    private static volatile String powerDiagnostic = "inactive";
    /** 原生播放器是否正在播放（供桥查询：前台自愈用）。 */
    private static volatile boolean nativePlayingFlag = false;

    public static boolean isNativePlaying() { return nativePlayingFlag; }

    // 音频焦点：显式向系统声明“本应用正在播放媒体”。华为/鸿蒙等 ROM 对 WebView 后台冻结尤其激进，
    // 没有音频焦点时系统更容易在切后台后挂起 WebView 里的音频流；持有焦点后后台播放稳定得多。
    private AudioManager audioManager;
    private AudioFocusRequest audioFocusRequest;
    private boolean audioFocusHeld = false;
    private boolean transientlyLostFocus = false;

    // --- Native playback engine (MediaPlayer, hard-decoded, bypasses WebView audio) ---
    // The WebView's <audio> + WebAudio path stutters and crackles on Android WebView. This
    // second playback scheme plays through a real Android MediaPlayer inside this service:
    // position/duration and completion events stream back to the JS layer over the bridge, and
    // the UI (progress, lyrics, controls) is driven by those values exactly like before.
    private MediaPlayer mediaPlayer;
    private boolean nativePlaying = false;
    private String nativeSourceUrl = "";
    private final Handler progressHandler = new Handler(Looper.getMainLooper());
    private final Runnable progressPoller = new Runnable() {
        @Override
        public void run() {
            if (mediaPlayer == null || !nativePlaying) return;
            try {
                long position = Math.max(0, mediaPlayer.getCurrentPosition());
                long duration = mediaPlayer.getDuration();
                if (duration > 0) {
                    FoliaNativePlugin.emitNativeProgress(position, duration);
                }
            } catch (Exception ignored) {
                // Player may be mid-teardown; the next poll simply does not fire.
            }
            progressHandler.postDelayed(this, 500);
        }
    };

    /**
     * Starts (or replaces) native playback of a remote URL.
     *
     * Cache-then-play: the whole song is downloaded into a local file first (cacheDir/songCache),
     * and only then does MediaPlayer play the file — network buffering can never stutter playback.
     * Already-cached songs play instantly from the file; if the download fails we fall back to
     * streaming the URL directly so the song is still audible.
     */
    public void playNative(String url, long positionMs) {
        stopNativePlayer();
        nativeSourceUrl = url;
        final File cached = songCacheFileFor(url);
        if (cached.exists() && cached.length() > 0) {
            startNativePlayer(cached.getAbsolutePath(), positionMs);
            return;
        }
        final String requestedUrl = url;
        downloadExecutor.execute(() -> {
            boolean downloaded = downloadToFile(requestedUrl, cached);
            mainHandler.post(() -> {
                if (!requestedUrl.equals(nativeSourceUrl)) return; // the song changed meanwhile
                if (downloaded && cached.length() > 0) {
                    startNativePlayer(cached.getAbsolutePath(), positionMs);
                } else {
                    // Streaming fallback: still audible over the bridge, and the Web layer may
                    // additionally fall back to the WebView element.
                    startNativePlayer(requestedUrl, positionMs);
                }
            });
        });
    }

    private void startNativePlayer(String source, long positionMs) {
        MediaPlayer player = new MediaPlayer();
        try {
            player.setAudioAttributes(new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                .build());
            player.setDataSource(source);
            player.setOnPreparedListener(p -> {
                if (positionMs > 0) p.seekTo((int) positionMs);
                p.start();
                nativePlaying = true;
                nativePlayingFlag = true;
                requestAudioFocus();
                updatePlaybackLocks(true);
                progressHandler.removeCallbacks(progressPoller);
                progressHandler.post(progressPoller);
                FoliaNativePlugin.emitNativeStarted(p.getDuration());
            });
            player.setOnCompletionListener(p -> {
                nativePlaying = false;
                nativePlayingFlag = false;
                progressHandler.removeCallbacks(progressPoller);
                FoliaNativePlugin.emitNativeEnded();
            });
            player.setOnErrorListener((p, what, extra) -> {
                nativePlaying = false;
                nativePlayingFlag = false;
                progressHandler.removeCallbacks(progressPoller);
                updatePlaybackLocks(false);
                FoliaNativePlugin.emitNativeError("media-error:" + what + ":" + extra);
                return true;
            });
            mediaPlayer = player;
            player.prepareAsync();
        } catch (Exception error) {
            nativePlaying = false;
            FoliaNativePlugin.emitNativeError(error.getMessage() == null ? "prepare-failed" : error.getMessage());
            releaseNativePlayer();
        }
    }

    /** 下载整曲到本地缓存文件；成功返回 true（目标文件非空）。 */
    private boolean downloadToFile(String url, File target) {
        try {
            Request request = new Request.Builder().url(url).build();
            try (Response response = audioClient.newCall(request).execute()) {
                if (!response.isSuccessful()) return false;
                ResponseBody body = response.body();
                if (body == null) return false;
                try (InputStream input = body.byteStream(); FileOutputStream output = new FileOutputStream(target)) {
                    byte[] buffer = new byte[64 * 1024];
                    int read;
                    while ((read = input.read(buffer)) != -1) {
                        output.write(buffer, 0, read);
                    }
                }
            }
            trimSongCache();
            return true;
        } catch (Exception error) {
            return false;
        }
    }

    private File songCacheFileFor(String url) {
        File dir = new File(getCacheDir(), "songCache");
        if (!dir.exists()) {
            dir.mkdirs();
        }
        return new File(dir, md5Hex(url) + ".bin");
    }

    /** 简单 LRU 上限：缓存文件超过 40 个或总大小超过 1.5GB 时，从最旧的开始清理。 */
    private void trimSongCache() {
        File dir = new File(getCacheDir(), "songCache");
        File[] files = dir.listFiles();
        if (files == null || files.length <= 40) return;
        Arrays.sort(files, Comparator.comparingLong(File::lastModified));
        long total = 0;
        for (File file : files) total += file.length();
        for (File file : files) {
            if (files.length <= 40 && total <= 1536L * 1024 * 1024) break;
            total -= file.length();
            file.delete();
        }
    }

    private static String md5Hex(String input) {
        try {
            MessageDigest digest = MessageDigest.getInstance("MD5");
            byte[] hash = digest.digest(input.getBytes(StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (byte b : hash) hex.append(String.format("%02x", b));
            return hex.toString();
        } catch (Exception error) {
            return String.valueOf(input.hashCode());
        }
    }

    public void pauseNative() {
        nativePlaying = false;
        nativePlayingFlag = false;
        progressHandler.removeCallbacks(progressPoller);
        if (mediaPlayer != null && mediaPlayer.isPlaying()) {
            mediaPlayer.pause();
        }
        updatePlaybackLocks(false);
        abandonAudioFocus();
    }

    public void resumeNative() {
        if (mediaPlayer == null) return;
        try {
            mediaPlayer.start();
            nativePlaying = true;
            nativePlayingFlag = true;
            requestAudioFocus();
            updatePlaybackLocks(true);
            progressHandler.post(progressPoller);
        } catch (Exception ignored) {
            FoliaNativePlugin.emitNativeError("resume-failed");
        }
    }

    public void seekNative(long positionMs) {
        if (mediaPlayer == null) return;
        try {
            mediaPlayer.seekTo((int) Math.max(0, positionMs));
        } catch (Exception ignored) { }
    }

    public void stopNativePlayer() {
        nativePlaying = false;
        nativePlayingFlag = false;
        progressHandler.removeCallbacks(progressPoller);
        releaseNativePlayer();
        updatePlaybackLocks(false);
        abandonAudioFocus();
    }

    private void releaseNativePlayer() {
        if (mediaPlayer != null) {
            try {
                mediaPlayer.stop();
            } catch (Exception ignored) { }
            mediaPlayer.release();
            mediaPlayer = null;
        }
    }

    private void requestAudioFocus() {
        ensureAudioFocus();
    }

    private final AudioManager.OnAudioFocusChangeListener audioFocusListener = focusChange -> {
        switch (focusChange) {
            case AudioManager.AUDIOFOCUS_LOSS:
                // 永久丢失（用户切到别的播放器）：放弃焦点并通知 Web 暂停，不自动恢复。
                transientlyLostFocus = false;
                abandonAudioFocus();
                emit("pause");
                break;
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT:
            case AudioManager.AUDIOFOCUS_LOSS_TRANSIENT_CAN_DUCK:
                // 短暂丢失（来电、导航语音）：先暂停，等 AUDIOFOCUS_GAIN 再续播。
                transientlyLostFocus = true;
                emit("pause");
                break;
            case AudioManager.AUDIOFOCUS_GAIN:
                if (transientlyLostFocus) {
                    transientlyLostFocus = false;
                    emit("play");
                }
                break;
            default:
                break;
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        createNotificationChannel();
        mediaSession = new MediaSession(this, "FoliaPlayback");
        mediaSession.setCallback(new MediaSession.Callback() {
            @Override public void onPlay() { emit("play"); }
            @Override public void onPause() { emit("pause"); }
            @Override public void onSkipToNext() { emit("next"); }
            @Override public void onSkipToPrevious() { emit("previous"); }
            @Override public void onStop() { emit("stop"); }
        });
        mediaSession.setActive(true);
        PowerManager powerManager = (PowerManager) getSystemService(POWER_SERVICE);
        if (powerManager != null) {
            wakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "Folia:Playback");
            wakeLock.setReferenceCounted(false);
        }
        WifiManager wifiManager = (WifiManager) getApplicationContext().getSystemService(WIFI_SERVICE);
        if (wifiManager != null) {
            int lockMode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
            wifiLock = wifiManager.createWifiLock(lockMode, "Folia:Playback");
            wifiLock.setReferenceCounted(false);
        }
        audioManager = (AudioManager) getSystemService(AUDIO_SERVICE);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || "clear".equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }

        String action = intent.getAction();
        if (action != null) {
            switch (action) {
                case "native-play":
                    playNative(intent.getStringExtra("url") == null ? "" : intent.getStringExtra("url"),
                        intent.getLongExtra("position", 0));
                    break;
                case "native-pause":
                    pauseNative();
                    break;
                case "native-resume":
                    resumeNative();
                    break;
                case "native-seek":
                    seekNative(intent.getLongExtra("position", 0));
                    break;
                case "native-stop":
                    stopNativePlayer();
                    break;
                default:
                    break;
            }
        }

        String title = intent.getStringExtra("title");
        String artist = intent.getStringExtra("artist");
        String album = intent.getStringExtra("album");
        String coverUrl = intent.getStringExtra("coverUrl");
        boolean playing = intent.getBooleanExtra("playing", false);
        long position = intent.getLongExtra("position", 0);
        long duration = intent.getLongExtra("duration", 0);
        currentArtworkUrl = coverUrl == null ? "" : coverUrl.trim();
        Bitmap retainedArtwork = appliedArtworkBitmap;
        if (currentArtworkUrl.isEmpty()) {
            appliedArtworkUrl = "";
            appliedArtworkBitmap = null;
            retainedArtwork = null;
        }
        if (!currentArtworkUrl.equals(lastRequestedCoverUrl)) {
            lastRequestedCoverUrl = currentArtworkUrl;
            FoliaNativePlugin.notePlaybackArtwork(
                currentArtworkUrl,
                currentArtworkUrl.isEmpty() ? "none" : "queued",
                ""
            );
        }

        mediaSession.setMetadata(buildMetadata(title, artist, album, duration, retainedArtwork, currentArtworkUrl));
        FoliaNativePlugin.notePlaybackArtworkApplied(retainedArtwork != null);
        mediaSession.setPlaybackState(new PlaybackState.Builder()
            .setActions(
                PlaybackState.ACTION_PLAY
                    | PlaybackState.ACTION_PAUSE
                    | PlaybackState.ACTION_PLAY_PAUSE
                    | PlaybackState.ACTION_SKIP_TO_NEXT
                    | PlaybackState.ACTION_SKIP_TO_PREVIOUS
                    | PlaybackState.ACTION_SEEK_TO
            )
            .setState(playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, position, playing ? 1f : 0f)
            .build());

        Notification notification = buildNotification(title, artist, playing, retainedArtwork);
        startForeground(NOTIFICATION_ID, notification);
        updatePlaybackLocks(playing);
        loadArtwork(currentArtworkUrl, bitmap -> {
            if (!currentArtworkUrl.equals(coverUrl == null ? "" : coverUrl.trim())) return;
            mediaSession.setMetadata(buildMetadata(title, artist, album, duration, bitmap, currentArtworkUrl));
            FoliaNativePlugin.notePlaybackArtworkApplied(bitmap != null);
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.notify(NOTIFICATION_ID, buildNotification(title, artist, playing, bitmap));
            }
        });
        return START_STICKY;
    }

    private MediaMetadata buildMetadata(
        String title,
        String artist,
        String album,
        long duration,
        Bitmap artwork,
        String coverUrl
    ) {
        MediaMetadata.Builder metadata = new MediaMetadata.Builder()
            .putString(MediaMetadata.METADATA_KEY_TITLE, title == null ? "Folia" : title)
            .putString(MediaMetadata.METADATA_KEY_ARTIST, artist == null ? "" : artist)
            .putString(MediaMetadata.METADATA_KEY_ALBUM, album == null ? "" : album)
            .putLong(MediaMetadata.METADATA_KEY_DURATION, duration);
        if (artwork == null && coverUrl != null && !coverUrl.isEmpty()) {
            metadata.putString(MediaMetadata.METADATA_KEY_ART_URI, coverUrl);
            metadata.putString(MediaMetadata.METADATA_KEY_ALBUM_ART_URI, coverUrl);
        }
        if (artwork != null) {
            metadata.putBitmap(MediaMetadata.METADATA_KEY_ART, artwork);
            metadata.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, artwork);
        }
        return metadata.build();
    }

    private Notification buildNotification(
        String title,
        String artist,
        boolean playing,
        Bitmap artwork
    ) {
        Intent activityIntent = new Intent(this, MainActivity.class);
        PendingIntent contentIntent = PendingIntent.getActivity(
            this,
            0,
            activityIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        int playPauseIcon = playing ? android.R.drawable.ic_media_pause : android.R.drawable.ic_media_play;
        PendingIntent playPauseIntent = PendingIntent.getBroadcast(
            this,
            1,
            new Intent(this, PlaybackActionReceiver.class).setAction(playing ? "pause" : "play"),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        PendingIntent previousIntent = PendingIntent.getBroadcast(
            this,
            2,
            new Intent(this, PlaybackActionReceiver.class).setAction("previous"),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        PendingIntent nextIntent = PendingIntent.getBroadcast(
            this,
            3,
            new Intent(this, PlaybackActionReceiver.class).setAction("next"),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        Notification.Builder builder = new Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_media_play)
            .setContentTitle(title == null ? "Folia" : title)
            .setContentText(artist == null ? "" : artist)
            .setContentIntent(contentIntent)
            .setOnlyAlertOnce(true)
            .setOngoing(playing)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .addAction(android.R.drawable.ic_media_previous, "Previous", previousIntent)
            .addAction(playPauseIcon, playing ? "Pause" : "Play", playPauseIntent)
            .addAction(android.R.drawable.ic_media_next, "Next", nextIntent)
            .setStyle(new Notification.MediaStyle()
                .setMediaSession(mediaSession.getSessionToken())
                .setShowActionsInCompactView(0, 1, 2));
        if (artwork != null) builder.setLargeIcon(artwork);
        return builder.build();
    }

    private void loadArtwork(String value, ArtworkCallback callback) {
        if (value == null || value.isEmpty()) return;
        if (value.equals(appliedArtworkUrl)) return;
        Bitmap cached = artworkCache.get(value);
        if (cached != null) {
            mainHandler.post(() -> {
                if (value.equals(currentArtworkUrl)) {
                    appliedArtworkUrl = value;
                    appliedArtworkBitmap = cached;
                    FoliaNativePlugin.notePlaybackArtwork(
                        value,
                        "loaded",
                        "cached " + cached.getWidth() + "x" + cached.getHeight()
                    );
                }
                callback.onLoaded(cached);
            });
            return;
        }
        if (!(value.startsWith("http://") || value.startsWith("https://"))) {
            FoliaNativePlugin.notePlaybackArtwork(value, "error", "unsupported-cover-url");
            return;
        }
        artworkExecutor.execute(() -> {
            Bitmap bitmap = null;
            String failure = "";
            try (Response response = artworkClient.newCall(new Request.Builder()
                .url(value)
                .header("User-Agent", "Mozilla/5.0 (Linux; Android 13; Mobile)")
                .build()).execute()) {
                ResponseBody body = response.body();
                if (response.isSuccessful() && body != null) {
                    try (InputStream input = body.byteStream()) {
                        bitmap = BitmapFactory.decodeStream(input);
                    }
                    if (bitmap == null) failure = "decode-failed";
                } else {
                    failure = "http-" + response.code();
                }
            } catch (Exception error) {
                failure = error.getClass().getSimpleName();
            }
            if (bitmap != null) artworkCache.put(value, bitmap);
            Bitmap resolved = bitmap;
            if (resolved != null) {
                mainHandler.post(() -> {
                    if (value.equals(currentArtworkUrl)) {
                        appliedArtworkUrl = value;
                        appliedArtworkBitmap = resolved;
                        FoliaNativePlugin.notePlaybackArtwork(
                            value,
                            "loaded",
                            resolved.getWidth() + "x" + resolved.getHeight()
                        );
                    }
                    callback.onLoaded(resolved);
                });
            } else {
                FoliaNativePlugin.notePlaybackArtwork(value, "error", failure.isEmpty() ? "unknown" : failure);
            }
        });
    }

    private interface ArtworkCallback {
        void onLoaded(Bitmap bitmap);
    }

    /**
     * Keeps the remote-audio proxy alive in the background.
     *
     * A foreground service keeps the process visible, but it does not stop Doze from throttling
     * the CPU or the Wi-Fi radio. Playback pulls the stream through LocalAudioServer, so losing
     * either one shows up as intermittent audio while the screen is off.
     */
    private void updatePlaybackLocks(boolean playing) {
        try {
            if (playing) {
                if (wakeLock != null && !wakeLock.isHeld()) wakeLock.acquire();
                if (wifiLock != null && !wifiLock.isHeld()) wifiLock.acquire();
                ensureAudioFocus();
            } else {
                if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
                if (wifiLock != null && wifiLock.isHeld()) wifiLock.release();
            }
            powerDiagnostic = "wake=" + (wakeLock != null && wakeLock.isHeld() ? "held" : "released")
                + " wifi=" + (wifiLock != null && wifiLock.isHeld() ? "held" : "released")
                + " error=none";
        } catch (Exception error) {
            powerDiagnostic = "wake=" + (wakeLock != null && wakeLock.isHeld() ? "held" : "released")
                + " wifi=" + (wifiLock != null && wifiLock.isHeld() ? "held" : "released")
                + " error=" + error.getClass().getSimpleName();
        }
    }

    static String getPowerDiagnostic() {
        return powerDiagnostic;
    }

    /** 播放时持有媒体音频焦点；已持有则不重复请求。 */
    private void ensureAudioFocus() {
        if (audioManager == null || audioFocusHeld) return;
        try {
            int result;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                AudioAttributes attributes = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build();
                audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
                    .setAudioAttributes(attributes)
                    .setWillPauseWhenDucked(false)
                    .setOnAudioFocusChangeListener(audioFocusListener)
                    .build();
                result = audioManager.requestAudioFocus(audioFocusRequest);
            } else {
                result = audioManager.requestAudioFocus(
                    audioFocusListener,
                    AudioManager.STREAM_MUSIC,
                    AudioManager.AUDIOFOCUS_GAIN
                );
            }
            audioFocusHeld = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED;
        } catch (Exception ignored) {
            audioFocusHeld = false;
        }
    }

    /** 服务停止时释放音频焦点。 */
    private void abandonAudioFocus() {
        if (audioManager == null) return;
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && audioFocusRequest != null) {
                audioManager.abandonAudioFocusRequest(audioFocusRequest);
                audioFocusRequest = null;
            } else {
                audioManager.abandonAudioFocus(audioFocusListener);
            }
        } catch (Exception ignored) {
            // 焦点释放失败不影响服务销毁。
        }
        audioFocusHeld = false;
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Folia playback",
                NotificationManager.IMPORTANCE_LOW
            );
            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) manager.createNotificationChannel(channel);
        }
    }

    private void emit(String action) {
        FoliaNativePlugin.emitMediaAction(action);
    }

    @Override
    public void onDestroy() {
        updatePlaybackLocks(false);
        abandonAudioFocus();
        progressHandler.removeCallbacks(progressPoller);
        releaseNativePlayer();
        downloadExecutor.shutdownNow();
        artworkExecutor.shutdownNow();
        if (mediaSession != null) {
            mediaSession.setActive(false);
            mediaSession.release();
        }
        super.onDestroy();
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
