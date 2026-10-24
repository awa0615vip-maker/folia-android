package top.izuna.foliamajor;

import android.Manifest;
import android.app.Activity;
import android.app.AlarmManager;
import android.app.DownloadManager;
import android.app.PendingIntent;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.content.BroadcastReceiver;
import android.content.IntentFilter;
import android.database.Cursor;
import android.os.Build;
import android.os.Environment;
import android.os.SystemClock;
import android.os.PowerManager;
import android.provider.DocumentsContract;
import android.provider.OpenableColumns;
import android.provider.MediaStore;
import android.provider.Settings;
import android.webkit.CookieManager;
import android.webkit.WebView;
import android.view.WindowManager;
import android.net.Uri;
import android.util.Base64;

import androidx.activity.result.ActivityResult;
import androidx.core.content.ContextCompat;
import androidx.core.content.FileProvider;

import com.getcapacitor.PermissionState;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.lang.reflect.Method;
import java.net.URL;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.TimeUnit;

import okhttp3.Headers;
import okhttp3.MediaType;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.RequestBody;
import okhttp3.Response;
import okhttp3.ResponseBody;

@CapacitorPlugin(
    name = "FoliaNative",
    permissions = {
        @Permission(
            alias = "audio",
            strings = { Manifest.permission.READ_MEDIA_AUDIO }
        ),
        @Permission(
            alias = "audioLegacy",
            strings = { Manifest.permission.READ_EXTERNAL_STORAGE }
        ),
        @Permission(
            alias = "notifications",
            strings = { Manifest.permission.POST_NOTIFICATIONS }
        )
    }
)
public class FoliaNativePlugin extends Plugin {
    private static volatile FoliaNativePlugin instance;
    private static volatile String playbackArtworkCover = "";
    private static volatile String playbackArtworkStatus = "none";
    private static volatile String playbackArtworkDetail = "";
    private static volatile long playbackArtworkAt = 0;
    private static volatile boolean playbackArtworkApplied = false;
    private final OkHttpClient client = new OkHttpClient.Builder()
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(45, TimeUnit.SECONDS)
        .writeTimeout(45, TimeUnit.SECONDS)
        .build();
    private LocalAudioServer localAudioServer;
    private boolean isAudioPickerOpen = false;
    private boolean isCoverPickerOpen = false;
    private boolean isLyricPickerOpen = false;
    private static final String DOWNLOAD_USER_AGENT =
        "Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36";

    // ===== 睡眠定时器（定时暂停） =====
    private static final int SLEEP_TIMER_REQUEST_CODE = 31010;
    // 已布防闹钟的触发时刻（基于 SystemClock.elapsedRealtime()，不受系统时间/时区影响）；0 表示未布防。
    private static volatile long sleepTimerDeadlineElapsedMs = 0L;

    // ===== 应用内更新（下载 APK 并安装） =====
    // APK 固定下载到应用专属下载目录（无需存储权限），每次覆盖，避免堆积。
    private static final String UPDATE_SUB_PATH = "Folia/folia-update.apk";
    private long updateDownloadId = -1L;
    private BroadcastReceiver updateDownloadReceiver;

    @Override
    public void load() {
        instance = this;
    }

    @Override
    protected void handleOnDestroy() {
        if (updateDownloadReceiver != null) {
            try {
                getContext().unregisterReceiver(updateDownloadReceiver);
            } catch (Exception ignored) {
                // receiver 未注册或已注销时忽略。
            }
            updateDownloadReceiver = null;
        }
        if (instance == this) instance = null;
        super.handleOnDestroy();
    }

    static void emitMediaAction(String action) {
        FoliaNativePlugin plugin = instance;
        if (plugin == null) return;
        JSObject payload = new JSObject();
        payload.put("action", action);
        plugin.getActivity().runOnUiThread(() -> plugin.notifyListeners("mediaAction", payload));
    }

    /**
     * Activity 前后台切换：onStart → "foreground"，onStop → "background"。
     * WebView 作为原生视图被切到后台时通常不会触发页面的 visibilitychange，
     * 因此由原生显式通知 Web 层：进后台暂停可视化渲染（只保留音频），回前台检查并续播。
     */
    static void emitAppLifecycle(String state) {
        FoliaNativePlugin plugin = instance;
        if (plugin == null) return;
        Activity activity = plugin.getActivity();
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            JSObject payload = new JSObject();
            payload.put("state", state);
            plugin.notifyListeners("appLifecycle", payload);
        });
    }

    /**
     * 睡眠定时器到期：在主线程暂停播放并通知 Web 层复位定时器状态。
     * 由 {@link SleepTimerReceiver} 通过精确闹钟唤起。
     */
    static void emitSleepTimerExpired() {
        FoliaNativePlugin plugin = instance;
        if (plugin == null) return;
        Activity activity = plugin.getActivity();
        if (activity == null) return;
        activity.runOnUiThread(() -> {
            sleepTimerDeadlineElapsedMs = 0L;
            // 复用媒体动作通道发送 pause，WebView 监听后执行真正的暂停。
            JSObject mediaPayload = new JSObject();
            mediaPayload.put("action", "pause");
            plugin.notifyListeners("mediaAction", mediaPayload);
            // 专用事件，让 Web 层把定时器开关与倒计时复位。
            plugin.notifyListeners("sleepTimerExpired", new JSObject());
        });
    }

    /** True when the WebView handled Back; false lets the activity fall back to normal exit. */
    static boolean emitBackPressed() {
        FoliaNativePlugin plugin = instance;
        if (plugin == null || !plugin.hasListeners("backButton")) return false;
        Activity activity = plugin.getActivity();
        if (activity == null) return false;
        JSObject payload = new JSObject();
        activity.runOnUiThread(() -> plugin.notifyListeners("backButton", payload));
        return true;
    }

    static void notePlaybackArtwork(String coverUrl, String status, String detail) {
        playbackArtworkCover = describePlaybackArtworkUrl(coverUrl);
        playbackArtworkStatus = status == null || status.isEmpty() ? "unknown" : status;
        playbackArtworkDetail = detail == null ? "" : detail;
        playbackArtworkAt = System.currentTimeMillis();
    }

    static void notePlaybackArtworkApplied(boolean applied) {
        playbackArtworkApplied = applied;
    }

    private static String describePlaybackArtworkUrl(String value) {
        if (value == null || value.isEmpty()) return "";
        try {
            URL url = new URL(value);
            return url.getProtocol() + "://" + url.getHost() + url.getPath();
        } catch (Exception ignored) {
            return "invalid";
        }
    }

    // ===== 应用内更新 =====

    private File resolveUpdateFile() {
        return new File(getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), UPDATE_SUB_PATH);
    }

    @PluginMethod
    public void getAppInfo(PluginCall call) {
        try {
            android.content.pm.PackageInfo info = getContext().getPackageManager()
                .getPackageInfo(getContext().getPackageName(), 0);
            String versionName = info.versionName != null ? info.versionName : "";
            long versionCode = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? info.getLongVersionCode()
                : info.versionCode;
            JSObject result = new JSObject();
            result.put("versionName", versionName);
            result.put("versionCode", versionCode);
            result.put("packageName", getContext().getPackageName());
            call.resolve(result);
        } catch (Exception error) {
            call.reject("getAppInfo failed: " + error.getMessage());
        }
    }

    /** 用系统 DownloadManager 下载 APK：通知栏可见、支持后台与断点续传，下载到应用专属目录（无需存储权限）。 */
    @PluginMethod
    public void downloadUpdate(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("Missing url");
            return;
        }
        try {
            File target = resolveUpdateFile();
            File parent = target.getParentFile();
            if (parent != null && !parent.exists()) parent.mkdirs();
            if (target.exists()) target.delete();

            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setTitle("Folia 更新");
            request.setDescription("正在下载最新版本，完成后将自动安装…");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setAllowedNetworkTypes(
                DownloadManager.Request.NETWORK_WIFI | DownloadManager.Request.NETWORK_MOBILE);
            request.setMimeType("application/vnd.android.package-archive");
            request.setDestinationInExternalFilesDir(
                getContext(), Environment.DIRECTORY_DOWNLOADS, UPDATE_SUB_PATH);
            request.addRequestHeader("Accept", "application/vnd.android.package-archive");

            DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            if (manager == null) {
                call.reject("DownloadManager unavailable");
                return;
            }
            long id = manager.enqueue(request);
            updateDownloadId = id;
            ensureUpdateReceiver();
            JSObject result = new JSObject();
            result.put("downloadId", id);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("downloadUpdate failed: " + error.getMessage());
        }
    }

    /** 轮询下载进度（Web 端每秒调用）。 */
    @PluginMethod
    public void getDownloadProgress(PluginCall call) {
        long id = call.getLong("downloadId", updateDownloadId);
        DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) {
            call.reject("DownloadManager unavailable");
            return;
        }
        int status = -1;
        long downloaded = 0;
        long total = 0;
        int reason = 0;
        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(id))) {
            if (cursor != null && cursor.moveToFirst()) {
                int sIdx = cursor.getColumnIndex(DownloadManager.COLUMN_STATUS);
                int dIdx = cursor.getColumnIndex(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR);
                int tIdx = cursor.getColumnIndex(DownloadManager.COLUMN_TOTAL_SIZE_BYTES);
                int rIdx = cursor.getColumnIndex(DownloadManager.COLUMN_REASON);
                if (sIdx >= 0) status = cursor.getInt(sIdx);
                if (dIdx >= 0) downloaded = cursor.getLong(dIdx);
                if (tIdx >= 0) total = cursor.getLong(tIdx);
                if (rIdx >= 0) reason = cursor.getInt(rIdx);
            }
        } catch (Exception ignored) {
            // 查询失败返回 unknown。
        }
        call.resolve(progressObject(id, mapDownloadStatus(status), downloaded, total, reason));
    }

    /** 手动触发安装（授权“未知来源”后 Web 端可再次调用）。 */
    @PluginMethod
    public void installDownloadedUpdate(PluginCall call) {
        boolean ok = installDownloadedApk();
        JSObject result = new JSObject();
        result.put("ok", ok);
        call.resolve(result);
    }

    private String mapDownloadStatus(int status) {
        switch (status) {
            case DownloadManager.STATUS_PENDING: return "pending";
            case DownloadManager.STATUS_RUNNING: return "running";
            case DownloadManager.STATUS_PAUSED: return "paused";
            case DownloadManager.STATUS_SUCCESSFUL: return "successful";
            case DownloadManager.STATUS_FAILED: return "failed";
            default: return "unknown";
        }
    }

    private JSObject progressObject(long id, String status, long downloaded, long total, int reason) {
        JSObject obj = new JSObject();
        obj.put("downloadId", id);
        obj.put("status", status);
        obj.put("downloaded", downloaded);
        obj.put("total", total);
        obj.put("reason", reason);
        return obj;
    }

    private void ensureUpdateReceiver() {
        if (updateDownloadReceiver != null) return;
        updateDownloadReceiver = new BroadcastReceiver() {
            @Override
            public void onReceive(Context context, Intent intent) {
                if (!DownloadManager.ACTION_DOWNLOAD_COMPLETE.equals(intent.getAction())) return;
                long id = intent.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L);
                if (id != updateDownloadId) return;

                int status = queryDownloadStatus(id);
                boolean success = status == DownloadManager.STATUS_SUCCESSFUL;
                JSObject payload = new JSObject();
                payload.put("downloadId", id);
                payload.put("success", success);
                payload.put("status", mapDownloadStatus(status));

                if (success) {
                    boolean installing = installDownloadedApk();
                    payload.put("installing", installing);
                    notifyListeners("updateDownloadProgress",
                        progressObject(id, "completed", 0, 0, 0));
                } else {
                    notifyListeners("updateDownloadProgress",
                        progressObject(id, "failed", 0, 0, 0));
                }
                notifyListeners("updateDownloadComplete", payload);
            }
        };
        IntentFilter filter = new IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getContext().registerReceiver(updateDownloadReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
        } else {
            getContext().registerReceiver(updateDownloadReceiver, filter);
        }
    }

    private int queryDownloadStatus(long id) {
        DownloadManager manager = (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
        if (manager == null) return -1;
        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(id))) {
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(DownloadManager.COLUMN_STATUS);
                if (idx >= 0) return cursor.getInt(idx);
            }
        } catch (Exception ignored) {
            // 忽略查询异常。
        }
        return -1;
    }

    /** 弹出系统安装器。返回 false 表示需要先引导用户授予“允许安装未知应用”。 */
    private boolean installDownloadedApk() {
        try {
            File apk = resolveUpdateFile();
            if (!apk.exists() || apk.length() == 0) return false;
            Context context = getContext();
            Uri uri = FileProvider.getUriForFile(
                context, context.getPackageName() + ".fileprovider", apk);

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !context.getPackageManager().canRequestPackageInstalls()) {
                Intent settings = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + context.getPackageName()));
                settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(settings);
                return false;
            }

            Intent install = new Intent(Intent.ACTION_VIEW);
            install.setDataAndType(uri, "application/vnd.android.package-archive");
            install.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            install.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(install);
            return true;
        } catch (Exception error) {
            return false;
        }
    }

    @PluginMethod
    public void cookiesGetAll(PluginCall call) {
        String url = call.getString("url", "");
        String domain = call.getString("domain", "");
        if (url == null || url.isEmpty()) {
            if (domain == null || domain.isEmpty()) {
                url = "https://localhost/";
            } else {
                url = domain.startsWith("http") ? domain : "https://" + domain;
            }
        }

        JSArray cookies = new JSArray();
        for (JSObject cookie : parseCookieHeader(CookieManager.getInstance().getCookie(url), domain)) {
            cookies.put(cookie);
        }
        JSObject result = new JSObject();
        result.put("cookies", cookies);
        call.resolve(result);
    }

    @PluginMethod
    public void cookiesGet(PluginCall call) {
        String url = call.getString("url", "https://localhost/");
        String name = call.getString("name", "");
        if (name == null || name.isEmpty()) {
            call.reject("Missing cookie name");
            return;
        }
        for (JSObject cookie : parseCookieHeader(CookieManager.getInstance().getCookie(url), "")) {
            if (name.equals(cookie.optString("name"))) {
                JSObject result = new JSObject();
                result.put("cookie", cookie);
                call.resolve(result);
                return;
            }
        }
        JSObject result = new JSObject();
        result.put("cookie", null);
        call.resolve(result);
    }

    @PluginMethod
    public void cookiesSet(PluginCall call) {
        String url = call.getString("url", "");
        String name = call.getString("name", "");
        String value = call.getString("value", "");
        if (url == null || url.isEmpty() || name == null || name.isEmpty()) {
            call.reject("Cookie url and name are required");
            return;
        }

        StringBuilder cookie = new StringBuilder();
        cookie.append(name).append('=').append(value == null ? "" : value);
        String domain = call.getString("domain", "");
        String path = call.getString("path", "/");
        if (domain != null && !domain.isEmpty()) cookie.append("; domain=").append(domain);
        if (path != null && !path.isEmpty()) cookie.append("; path=").append(path);
        if (Boolean.TRUE.equals(call.getBoolean("secure", false))) cookie.append("; Secure");
        Double expirationDate = call.getDouble("expirationDate");
        if (expirationDate != null) {
            cookie.append("; Max-Age=").append((int) Math.max(0, expirationDate - System.currentTimeMillis() / 1000.0));
        }

        CookieManager.getInstance().setCookie(url, cookie.toString());
        CookieManager.getInstance().flush();
        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    @PluginMethod
    public void cookiesRemove(PluginCall call) {
        String url = call.getString("url", "");
        String name = call.getString("name", "");
        if (url == null || url.isEmpty() || name == null || name.isEmpty()) {
            call.reject("Cookie url and name are required");
            return;
        }
        CookieManager.getInstance().setCookie(url, name + "=; Max-Age=0; path=/");
        CookieManager.getInstance().flush();
        JSObject result = new JSObject();
        result.put("ok", true);
        call.resolve(result);
    }

    /**
     * 批量删除 cookie：entries 是 [{url, name}, ...]。
     *
     * 逐条删除每条都要过一次桥并在原生侧 flush 一次，登录通道切换要清几十条，
     * 累加起来会超过调用方的截止时间，结果只清掉一半。这里在原生侧一次做完。
     */
    @PluginMethod
    public void cookiesRemoveBatch(PluginCall call) {
        JSArray entries = call.getArray("entries");
        if (entries == null || entries.length() == 0) {
            JSObject empty = new JSObject();
            empty.put("ok", true);
            empty.put("removed", 0);
            call.resolve(empty);
            return;
        }
        CookieManager manager = CookieManager.getInstance();
        int removed = 0;
        for (int index = 0; index < entries.length(); index++) {
            JSONObject entry = entries.optJSONObject(index);
            if (entry == null) continue;
            String url = entry.optString("url", "");
            String name = entry.optString("name", "");
            if (url == null || url.isEmpty() || name == null || name.isEmpty()) continue;
            manager.setCookie(url, name + "=; Max-Age=0; path=/");
            removed++;
        }
        if (removed > 0) manager.flush();
        JSObject result = new JSObject();
        result.put("ok", true);
        result.put("removed", removed);
        call.resolve(result);
    }

    @PluginMethod
    public void httpRequest(PluginCall call) {
        String url = call.getString("url", "");
        String method = call.getString("method", "GET");
        String bodyText = call.getString("bodyText", "");
        String bodyBase64 = call.getString("bodyBase64", "");
        String redirect = call.getString("redirect", "follow");
        if (url == null || url.isEmpty()) {
            call.reject("Missing request url");
            return;
        }

        try {
            Request.Builder builder = new Request.Builder().url(url);
            JSObject headers = call.getObject("headers");
            if (headers != null) {
                Iterator<String> headerNames = headers.keys();
                while (headerNames.hasNext()) {
                    String headerName = headerNames.next();
                    Object headerValue = headers.opt(headerName);
                    if (headerValue != null) {
                        builder.header(headerName, String.valueOf(headerValue));
                    }
                }
            }
            // OkHttp has no cookie jar here, so carry the WebView cookie store
            // ourselves unless the caller injected an explicit Cookie header.
            if (headers == null || headers.optString("cookie") == null) {
                String storedCookies = CookieManager.getInstance().getCookie(url);
                if (storedCookies != null && !storedCookies.isEmpty()) {
                    builder.header("Cookie", storedCookies);
                }
            }

            RequestBody body = null;
            if (bodyBase64 != null && !bodyBase64.isEmpty()) {
                body = RequestBody.create(MediaType.parse("application/octet-stream"), Base64.decode(bodyBase64, Base64.DEFAULT));
            } else if (bodyText != null && !bodyText.isEmpty()) {
                MediaType mediaType = MediaType.parse(headers == null ? null : headers.optString("content-type", null));
                body = RequestBody.create(mediaType, bodyText);
            }
            String requestMethod = method == null ? "GET" : method;
            if (body != null && "GET".equalsIgnoreCase(requestMethod)) {
                // Bodian's playback endpoints use GET with a JSON body. OkHttp's public
                // method() rejects that combination, so set the validated request body
                // through its own setter after selecting GET.
                builder.method("GET", null);
                try {
                    Method setBody = Request.Builder.class.getMethod("setBody$okhttp", RequestBody.class);
                    setBody.invoke(builder, body);
                } catch (ReflectiveOperationException error) {
                    call.reject("GET request body is unsupported by this runtime", error);
                    return;
                }
            } else {
                builder.method(requestMethod, body);
            }

            OkHttpClient requestClient = client;
            if ("manual".equals(redirect)) {
                requestClient = client.newBuilder()
                    .followRedirects(false)
                    .followSslRedirects(false)
                    .build();
            }
            // AI 请求可能远超默认的 45s 读超时，调用方可以按需放宽。
            Integer timeoutMs = call.getInt("timeoutMs");
            if (timeoutMs != null && timeoutMs > 0) {
                requestClient = requestClient.newBuilder()
                    .readTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .writeTimeout(timeoutMs, TimeUnit.MILLISECONDS)
                    .build();
            }

            String requestUrl = url;
            try (Response response = requestClient.newCall(builder.build()).execute()) {
                // Preserve repeated headers (Set-Cookie) by handing JS an array
                // instead of an object, which would collapse duplicates.
                JSArray responseHeaders = new JSArray();
                // Non-cookie headers come from the final response only.
                for (String name : response.headers().names()) {
                    if (name.equalsIgnoreCase("set-cookie")) continue; // collected along the whole chain below
                    for (String value : response.headers().values(name)) {
                        JSObject headerEntry = new JSObject();
                        headerEntry.put("name", name);
                        headerEntry.put("value", value);
                        responseHeaders.put(headerEntry);
                    }
                }
                // OkHttp follows redirects automatically and only surfaces the final response,
                // dropping the Set-Cookie headers attached to intermediate 302 hops. The QR
                // redirect_url puts the session cookies precisely on those hops, so walk the
                // priorResponse chain to collect every Set-Cookie.
                for (Response hop = response; hop != null; hop = hop.priorResponse()) {
                    for (String value : hop.headers().values("Set-Cookie")) {
                        JSObject headerEntry = new JSObject();
                        headerEntry.put("name", "set-cookie");
                        headerEntry.put("value", value);
                        responseHeaders.put(headerEntry);
                    }
                }
                storeResponseCookies(requestUrl, response);
                ResponseBody responseBody = response.body();
                byte[] bytes = responseBody == null ? new byte[0] : responseBody.bytes();
                JSObject result = new JSObject();
                result.put("status", response.code());
                result.put("headers", responseHeaders);
                result.put("bodyBase64", Base64.encodeToString(bytes, Base64.NO_WRAP));
                call.resolve(result);
            }
        } catch (IOException | IllegalArgumentException error) {
            call.reject(error.getMessage(), error);
        }
    }

    private void storeResponseCookies(String requestUrl, Response response) {
        List<String> setCookies = response.headers().values("Set-Cookie");
        if (setCookies.isEmpty()) return;
        CookieManager manager = CookieManager.getInstance();
        boolean changed = false;
        for (String rawCookie : setCookies) {
            String cookie = normalizeCookieForUrl(requestUrl, rawCookie);
            if (cookie == null || cookie.isEmpty()) continue;
            manager.setCookie(requestUrl, cookie);
            changed = true;
        }
        if (changed) manager.flush();
    }

    // CookieManager ignores a Set-Cookie that has no Path/Domain even though
    // every real response carries them, but some providers omit Path entirely.
    private static String normalizeCookieForUrl(String requestUrl, String rawCookie) {
        if (rawCookie == null || rawCookie.isEmpty()) return null;
        boolean hasPath = false;
        for (String attribute : rawCookie.split(";")) {
            if (attribute.trim().toLowerCase().startsWith("path=")) {
                hasPath = true;
                break;
            }
        }
        if (hasPath) return rawCookie;
        return rawCookie + "; Path=/";
    }

    @PluginMethod
    public void scanLocalAudio(PluginCall call) {
        String alias = audioPermissionAlias();
        if (getPermissionState(alias) != PermissionState.GRANTED) {
            requestPermissionForAlias(alias, call, "audioPermissionCallback");
            return;
        }
        resolveLocalAudioScan(call);
    }

    /**
     * Android 13 起读音频用 READ_MEDIA_AUDIO，之前的版本用 READ_EXTERNAL_STORAGE。
     *
     * 这两个权限不能放在同一个别名里：被申请的那一个拿到授权后，另一个在系统看来仍是
     * 拒绝，而 Capacitor 对同一别名取「全部授权才算授权」，结果永远停在 PROMPT，
     * 扫描会被误判成「权限被拒」。所以按系统版本分开取别名。
     */
    private String audioPermissionAlias() {
        return Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU ? "audio" : "audioLegacy";
    }

    @PluginMethod
    public void pickAudioFiles(PluginCall call) {
        if (isAudioPickerOpen) {
            call.reject("Audio picker is already open");
            return;
        }
        // 用 Capacitor 自己的活动回调机制（@ActivityCallback + startActivityForResult），
        // 而不是在 load() 里直接 registerForActivityResult：后者依赖活动生命周期时序，
        // 在部分设备上会拿不到可用的启动器，表现就是「点了导入毫无反应」。
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("audio/*")
            .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        isAudioPickerOpen = true;
        startActivityForResult(call, intent, "handlePickedAudio");
    }

    /** 选择整个文件夹；原生侧递归扫描其中的音频，用户可以一次导入整张专辑/目录。 */
    @PluginMethod
    public void pickAudioFolder(PluginCall call) {
        if (isAudioPickerOpen) {
            call.reject("Audio picker is already open");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE)
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        isAudioPickerOpen = true;
        startActivityForResult(call, intent, "handlePickedAudioFolder");
    }

    // ===== 汽水音乐「内置网页登录」：在 App 内 WebView 扫码登录，回传整段 Cookie =====

    @PluginMethod
    public void openQishuiWebLogin(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("No activity");
            return;
        }
        String url = call.getString("url", "");
        Intent intent = new Intent(activity, QishuiLoginActivity.class);
        if (url != null && !url.isEmpty()) {
            intent.putExtra(QishuiLoginActivity.EXTRA_URL, url);
        }
        startActivityForResult(call, intent, "handleQishuiWebLogin");
    }

    @ActivityCallback
    private void handleQishuiWebLogin(PluginCall call, ActivityResult activityResult) {
        if (call == null) return;
        int resultCode = activityResult == null ? Activity.RESULT_CANCELED : activityResult.getResultCode();
        Intent data = activityResult == null ? null : activityResult.getData();
        if (resultCode != Activity.RESULT_OK || data == null) {
            JSObject cancelled = new JSObject();
            cancelled.put("cancelled", true);
            call.resolve(cancelled);
            return;
        }
        String cookie = data.getStringExtra(QishuiLoginActivity.EXTRA_COOKIE);
        String finalUrl = data.getStringExtra(QishuiLoginActivity.EXTRA_FINAL_URL);
        String cookieKeys = data.getStringExtra(QishuiLoginActivity.EXTRA_COOKIE_KEYS);
        JSObject result = new JSObject();
        result.put("cancelled", false);
        result.put("cookie", cookie == null ? "" : cookie);
        result.put("url", finalUrl == null ? "" : finalUrl);
        result.put("cookieKeys", cookieKeys == null ? "" : cookieKeys);
        call.resolve(result);
    }

    /** 供 WebView 重建导入音频的流地址（端口每次启动都可能不同）。 */
    @PluginMethod
    public void localAudioServerPort(PluginCall call) {
        try {
            if (localAudioServer == null) localAudioServer = new LocalAudioServer(getContext());
            int port = localAudioServer.start();
            JSObject result = new JSObject();
            result.put("port", port);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    /** 自适应屏幕分辨率开关：关闭＝跟随系统原生布局，打开＝沉浸式全屏铺满。 */
    /** Wraps an issued Kuwo/Bodian audio URL behind the local Range-capable stream server. */
    @PluginMethod
    public void registerRemoteAudio(PluginCall call) {
        String url = call.getString("url", "");
        if (url == null || url.isEmpty()) {
            call.reject("Missing remote audio url");
            return;
        }
        try {
            if (localAudioServer == null) localAudioServer = new LocalAudioServer(getContext());
            String localUrl = localAudioServer.registerRemoteAudio(url);
            JSObject result = new JSObject();
            result.put("url", localUrl);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void getPlaybackDiagnostics(PluginCall call) {
        JSObject result = new JSObject();
        result.put("cover", playbackArtworkCover);
        result.put("status", playbackArtworkStatus);
        result.put("detail", playbackArtworkDetail);
        result.put("at", playbackArtworkAt);
        result.put("applied", playbackArtworkApplied);
        result.put("power", FoliaPlaybackService.getPowerDiagnostic());
        call.resolve(result);
    }

    @PluginMethod
    public void exitApp(PluginCall call) {
        Activity activity = getActivity();
        call.resolve();
        if (activity != null) activity.runOnUiThread(activity::finish);
    }

    // ===== 睡眠定时器（定时暂停） =====

    private PendingIntent buildSleepTimerPendingIntent() {
        Context context = getContext();
        Intent intent = new Intent(context, SleepTimerReceiver.class);
        intent.setAction(SleepTimerReceiver.ACTION_SLEEP_TIMER_FIRED);
        return PendingIntent.getBroadcast(
            context,
            SLEEP_TIMER_REQUEST_CODE,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
    }

    /** 布防睡眠定时器。入参 durationMs：多少毫秒后暂停播放。 */
    @PluginMethod
    public void armSleepTimer(PluginCall call) {
        Long durationMs = call.getLong("durationMs");
        if (durationMs == null || durationMs <= 0) {
            call.reject("durationMs must be a positive number");
            return;
        }
        Context context = getContext();
        AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) {
            call.reject("AlarmManager unavailable");
            return;
        }

        // 先取消上一次闹钟，保证每次布防都是全新的倒计时。
        alarmManager.cancel(buildSleepTimerPendingIntent());

        long triggerAtElapsed = SystemClock.elapsedRealtime() + durationMs;
        sleepTimerDeadlineElapsedMs = triggerAtElapsed;
        PendingIntent operation = buildSleepTimerPendingIntent();

        try {
            // 精确闹钟，Doze 下也能准时唤醒（API 31+ 需 SCHEDULE_EXACT_ALARM / USE_EXACT_ALARM 权限）。
            alarmManager.setExactAndAllowWhileIdle(
                AlarmManager.ELAPSED_REALTIME_WAKEUP,
                triggerAtElapsed,
                operation
            );
        } catch (SecurityException securityException) {
            // 缺少精确闹钟权限时降级为普通闹钟，仍会触发，仅可能有少量误差。
            alarmManager.set(AlarmManager.ELAPSED_REALTIME_WAKEUP, triggerAtElapsed, operation);
        }

        JSObject result = new JSObject();
        result.put("deadlineMs", System.currentTimeMillis() + durationMs);
        call.resolve(result);
    }

    /** 取消睡眠定时器。 */
    @PluginMethod
    public void cancelSleepTimer(PluginCall call) {
        cancelSleepTimerInternal();
        call.resolve();
    }

    private void cancelSleepTimerInternal() {
        Context context = getContext();
        AlarmManager alarmManager = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (alarmManager != null) {
            alarmManager.cancel(buildSleepTimerPendingIntent());
        }
        sleepTimerDeadlineElapsedMs = 0L;
    }

    /** 查询剩余毫秒（未布防时返回 0）。 */
    @PluginMethod
    public void getSleepTimerRemainingMs(PluginCall call) {
        long remainingMs = 0L;
        if (sleepTimerDeadlineElapsedMs > 0) {
            remainingMs = Math.max(0L, sleepTimerDeadlineElapsedMs - SystemClock.elapsedRealtime());
        }
        JSObject result = new JSObject();
        result.put("remainingMs", remainingMs);
        call.resolve(result);
    }

    @PluginMethod
    public void getPhoneFitLayout(PluginCall call) {
        JSObject result = new JSObject();
        result.put("enabled", PhoneLayoutOrientation.isEnabled(getContext()));
        result.put("orientation", PhoneLayoutOrientation.getOrientation(getContext()));
        call.resolve(result);
    }

    /**
     * 屏幕常亮：直接操作窗口标志。
     *
     * 网页的 Screen Wake Lock 在页面隐藏时会被浏览器释放，而且要重新申请；窗口标志是系统级的，
     * 切页、锁屏前都有效，所以安卓这边以它为准（JS 侧在拿不到插件时才退回 Wake Lock）。
     */
    @PluginMethod
    public void setKeepScreenOn(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        Activity activity = getActivity();
        if (activity != null) {
            activity.runOnUiThread(() -> {
                if (enabled) {
                    activity.getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                } else {
                    activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                }
            });
        }
        JSObject result = new JSObject();
        result.put("enabled", enabled);
        call.resolve(result);
    }

    @PluginMethod
    public void setPhoneFitLayout(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        String orientation = call.getString("orientation", PhoneLayoutOrientation.getOrientation(getContext()));
        PhoneLayoutOrientation.update(getContext(), enabled, orientation);
        Activity activity = getActivity();
        if (activity != null) {
            activity.runOnUiThread(() -> {
                PhoneLayoutOrientation.apply(activity);
                // 挖孔适配跟手机适配开关无关，这里只是顺手在开关变化时再铺一次。
                PhoneFitCutout.apply(activity);
                WebView webView = getBridge() == null ? null : getBridge().getWebView();
                if (webView != null && AdaptiveLayout.isEnabled(getContext())) {
                    AdaptiveLayout.apply(activity, webView, true);
                }
            });
        }
        JSObject result = new JSObject();
        result.put("enabled", enabled);
        result.put("orientation", PhoneLayoutOrientation.getOrientation(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void setAdaptiveLayout(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        try {
            AdaptiveLayout.setEnabled(getContext(), enabled);
            Activity activity = getActivity();
            if (activity != null) {
                WebView webView = getBridge() == null ? null : getBridge().getWebView();
                // 系统栏显隐必须在主线程上做。
                activity.runOnUiThread(() -> AdaptiveLayout.apply(activity, webView, enabled));
            }
            JSObject result = new JSObject();
            result.put("enabled", enabled);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @PluginMethod
    public void getAdaptiveLayout(PluginCall call) {
        JSObject result = new JSObject();
        result.put("enabled", AdaptiveLayout.isEnabled(getContext()));
        call.resolve(result);
    }

    @PluginMethod
    public void getDisplayCutout(PluginCall call) {
        try {
            call.resolve(JSObject.fromJSONObject(PhoneFitCutout.describe(getActivity())));
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    @ActivityCallback
    private void handlePickedAudio(PluginCall call, ActivityResult activityResult) {
        isAudioPickerOpen = false;
        if (call == null) return;

        // -1 = RESULT_OK，0 = RESULT_CANCELED。区分「用户取消」和「选完了却没数据」，
        // 否则两种情况的返回值一模一样，只能靠猜。
        int resultCode = activityResult == null ? Activity.RESULT_CANCELED : activityResult.getResultCode();
        List<Uri> uris = new ArrayList<>();
        Intent data = activityResult == null ? null : activityResult.getData();
        if (data != null) {
            ClipData clipData = data.getClipData();
            if (clipData != null) {
                for (int index = 0; index < clipData.getItemCount(); index += 1) {
                    Uri uri = clipData.getItemAt(index).getUri();
                    if (uri != null) uris.add(uri);
                }
            } else if (data.getData() != null) {
                uris.add(data.getData());
            }
        }

        completePickedAudioImport(call, uris, resultCode);
    }

    @ActivityCallback
    private void handlePickedAudioFolder(PluginCall call, ActivityResult activityResult) {
        isAudioPickerOpen = false;
        if (call == null) return;
        int resultCode = activityResult == null ? Activity.RESULT_CANCELED : activityResult.getResultCode();
        List<Uri> uris = new ArrayList<>();
        Intent data = activityResult == null ? null : activityResult.getData();
        Uri treeUri = data == null ? null : data.getData();
        if (treeUri != null) {
            try {
                getContext().getContentResolver().takePersistableUriPermission(
                    treeUri,
                    data.getFlags() & Intent.FLAG_GRANT_READ_URI_PERMISSION
                );
            } catch (Exception ignored) {
                // Some providers do not offer persistable grants; the current grant is still usable.
            }
            collectAudioDocuments(treeUri, DocumentsContract.getTreeDocumentId(treeUri), uris);
        }
        completePickedAudioImport(call, uris, resultCode);
    }

    private void collectAudioDocuments(Uri treeUri, String parentDocumentId, List<Uri> output) {
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocumentId);
        String[] projection = new String[]{
            DocumentsContract.Document.COLUMN_DOCUMENT_ID,
            DocumentsContract.Document.COLUMN_DISPLAY_NAME,
            DocumentsContract.Document.COLUMN_MIME_TYPE
        };
        try (Cursor cursor = getContext().getContentResolver().query(childrenUri, projection, null, null, null)) {
            if (cursor == null) return;
            while (cursor.moveToNext()) {
                String documentId = cursor.getString(0);
                String displayName = cursor.getString(1);
                String mimeType = cursor.getString(2);
                if (DocumentsContract.Document.MIME_TYPE_DIR.equals(mimeType)) {
                    collectAudioDocuments(treeUri, documentId, output);
                    continue;
                }
                if (isAudioDocument(displayName, mimeType)) {
                    output.add(DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId));
                }
            }
        } catch (Exception ignored) {
            // A provider can deny one subtree without invalidating the rest of the selection.
        }
    }

    private static boolean isAudioDocument(String displayName, String mimeType) {
        if (mimeType != null && mimeType.startsWith("audio/")) return true;
        String lower = displayName == null ? "" : displayName.toLowerCase(Locale.ROOT);
        return lower.endsWith(".mp3") || lower.endsWith(".flac") || lower.endsWith(".wav")
            || lower.endsWith(".m4a") || lower.endsWith(".aac") || lower.endsWith(".ogg")
            || lower.endsWith(".opus") || lower.endsWith(".ape") || lower.endsWith(".wma");
    }

    private void completePickedAudioImport(PluginCall call, List<Uri> uris, int resultCode) {
        if (uris.isEmpty()) {
            JSObject result = new JSObject();
            result.put("tracks", new JSArray());
            result.put("cancelled", resultCode != Activity.RESULT_OK);
            result.put("picked", 0);
            result.put("resultCode", resultCode);
            if (resultCode == Activity.RESULT_OK) {
                result.put("error", "Picker returned RESULT_OK without a readable document uri");
            }
            call.resolve(result);
            return;
        }

        final Activity activity = getActivity();
        new Thread(() -> {
          try {
            if (localAudioServer == null) localAudioServer = new LocalAudioServer(getContext());
            int port = localAudioServer.start();
            File directory = localAudioServer.importedAudioDirectory();
            ContentResolver resolver = getContext().getContentResolver();
            JSArray tracks = new JSArray();
            JSArray failures = new JSArray();
            int copied = 0;

            for (Uri uri : uris) {
                try {
                    String displayName = queryDisplayName(resolver, uri);
                    long fileSize = queryFileSize(resolver, uri);
                    if (displayName == null || displayName.isEmpty()) displayName = "track-" + System.currentTimeMillis();
                    String safeName = "imported-" + stableFileId(displayName, fileSize, directory);
                    File target = new File(directory, safeName);
                    if (!target.isFile() || target.length() != fileSize) {
                        try (InputStream source = resolver.openInputStream(uri);
                             OutputStream sink = new FileOutputStream(target)) {
                            if (source == null) continue;
                            byte[] buffer = new byte[128 * 1024];
                            int read;
                            while ((read = source.read(buffer)) != -1) {
                                sink.write(buffer, 0, read);
                            }
                        }
                    }

                    JSObject track = new JSObject();
                    track.put("id", safeName);
                    track.put("fileName", displayName);
                    track.put("fileSize", target.length());
                    track.put("mimeType", LocalAudioServer.guessMimeType(safeName));
                    track.put("url", "http://127.0.0.1:" + port + "/audio/" + safeName);
                    tracks.put(track);
                    copied += 1;
                } catch (Exception error) {
                    // 单个文件读不了不该让整批失败，但必须把原因带回去，
                    // 否则界面只会「什么都没发生」。
                    JSObject failure = new JSObject();
                    failure.put("uri", String.valueOf(uri));
                    failure.put("message", error.getMessage() == null ? error.toString() : error.getMessage());
                    failures.put(failure);
                }
            }

            JSObject result = new JSObject();
            result.put("tracks", tracks);
            result.put("port", port);
            result.put("picked", uris.size());
            result.put("copied", copied);
            result.put("failures", failures);
            result.put("resultCode", resultCode);
            if (activity != null) activity.runOnUiThread(() -> call.resolve(result));
            else call.resolve(result);
          } catch (Exception error) {
            String message = error.getMessage() == null ? error.toString() : error.getMessage();
            if (activity != null) activity.runOnUiThread(() -> call.reject(message, error));
            else call.reject(message, error);
          }
        }, "folia-audio-import").start();
    }

    private static String stableFileId(String displayName, long fileSize, File directory) {
        String candidate = displayName.replaceAll("[^A-Za-z0-9._-]", "_");
        if (candidate.length() > 60) {
            candidate = candidate.substring(candidate.length() - 60);
        }
        int dot = candidate.lastIndexOf('.');
        String base = dot > 0 ? candidate.substring(0, dot) : candidate;
        String extension = dot > 0 ? candidate.substring(dot) : "";
        String stamp = Integer.toHexString((displayName + ':' + fileSize).hashCode());
        String name = base + "-" + stamp + extension;
        if (new File(directory, name).isFile()) return name;
        return name;
    }

    private static String queryDisplayName(ContentResolver resolver, Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) return cursor.getString(0);
        } catch (Exception ignored) {
        }
        String last = uri.getLastPathSegment();
        return last == null ? null : last.substring(last.lastIndexOf('/') + 1);
    }

    private static long queryFileSize(ContentResolver resolver, Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[]{OpenableColumns.SIZE}, null, null, null)) {
            if (cursor != null && cursor.moveToFirst() && !cursor.isNull(0)) return cursor.getLong(0);
        } catch (Exception ignored) {
        }
        return -1;
    }

    @PluginMethod
    public void updatePlaybackState(PluginCall call) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU
            && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notificationsPermissionCallback");
            return;
        }
        applyPlaybackState(call);
    }

    @PermissionCallback
    private void notificationsPermissionCallback(PluginCall call) {
        applyPlaybackState(call);
    }

    private void applyPlaybackState(PluginCall call) {
        Intent intent = new Intent(getContext(), FoliaPlaybackService.class);
        intent.putExtra("title", call.getString("title", ""));
        intent.putExtra("artist", call.getString("artist", ""));
        intent.putExtra("album", call.getString("album", ""));
        intent.putExtra("coverUrl", call.getString("coverUrl", ""));
        intent.putExtra("playing", Boolean.TRUE.equals(call.getBoolean("playing", false)));
        Double position = call.getDouble("position");
        Double duration = call.getDouble("duration");
        intent.putExtra("position", position == null ? 0L : position.longValue());
        intent.putExtra("duration", duration == null ? 0L : duration.longValue());
        ContextCompat.startForegroundService(getContext(), intent);
        call.resolve();
    }

    @PluginMethod
    public void clearPlaybackState(PluginCall call) {
        getContext().stopService(new Intent(getContext(), FoliaPlaybackService.class));
        call.resolve();
    }


    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        Context context = getContext();
        PowerManager powerManager = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        boolean ignoring = powerManager != null && powerManager.isIgnoringBatteryOptimizations(context.getPackageName());
        JSObject result = new JSObject();
        result.put("ignoring", ignoring);
        call.resolve(result);
    }

    /** 发起电池优化豁免请求（系统弹窗，用户确认；MIUI 需另在设置里放行自启动）。 */
    @PluginMethod
    public void requestIgnoreBatteryOptimizations(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("no activity");
            return;
        }
        try {
            PowerManager powerManager = (PowerManager) activity.getSystemService(Context.POWER_SERVICE);
            if (powerManager != null && powerManager.isIgnoringBatteryOptimizations(activity.getPackageName())) {
                JSObject result = new JSObject();
                result.put("alreadyIgnoring", true);
                call.resolve(result);
                return;
            }
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS)
                .setData(android.net.Uri.parse("package:" + activity.getPackageName()));
            activity.startActivity(intent);
            call.resolve();
        } catch (Exception error) {
            call.reject(error.getMessage());
        }
    }

    @PermissionCallback
    private void audioPermissionCallback(PluginCall call) {
        if (getPermissionState(audioPermissionAlias()) == PermissionState.GRANTED) {
            resolveLocalAudioScan(call);
        } else {
            call.reject("Audio permission denied");
        }
    }

    private void resolveLocalAudioScan(PluginCall call) {
        try {
            if (localAudioServer == null) {
                localAudioServer = new LocalAudioServer(getContext());
            }
            int port = localAudioServer.start();
            JSArray tracks = new JSArray();
            String[] projection = new String[]{
                MediaStore.Audio.Media._ID,
                MediaStore.Audio.Media.DISPLAY_NAME,
                MediaStore.Audio.Media.TITLE,
                MediaStore.Audio.Media.ARTIST,
                MediaStore.Audio.Media.ALBUM,
                MediaStore.Audio.Media.DURATION,
                MediaStore.Audio.Media.SIZE,
                MediaStore.Audio.Media.MIME_TYPE
            };
            try (Cursor cursor = getContext().getContentResolver().query(
                MediaStore.Audio.Media.EXTERNAL_CONTENT_URI,
                projection,
                MediaStore.Audio.Media.IS_MUSIC + " != 0",
                null,
                MediaStore.Audio.Media.TITLE + " COLLATE NOCASE ASC"
            )) {
                if (cursor != null) {
                    int idColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media._ID);
                    int nameColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DISPLAY_NAME);
                    int titleColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.TITLE);
                    int artistColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ARTIST);
                    int albumColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.ALBUM);
                    int durationColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.DURATION);
                    int sizeColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.SIZE);
                    int mimeColumn = cursor.getColumnIndexOrThrow(MediaStore.Audio.Media.MIME_TYPE);
                    while (cursor.moveToNext()) {
                        long id = cursor.getLong(idColumn);
                        JSObject track = new JSObject();
                        track.put("id", String.valueOf(id));
                        track.put("fileName", cursor.getString(nameColumn));
                        track.put("title", cursor.getString(titleColumn));
                        track.put("artist", cursor.getString(artistColumn));
                        track.put("album", cursor.getString(albumColumn));
                        track.put("duration", cursor.getLong(durationColumn));
                        track.put("fileSize", cursor.getLong(sizeColumn));
                        track.put("mimeType", cursor.getString(mimeColumn));
                        track.put("url", "http://127.0.0.1:" + port + "/audio/" + id);
                        tracks.put(track);
                    }
                }
            }
            JSObject result = new JSObject();
            result.put("tracks", tracks);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    /**
     * 删除「导入文件夹」时复制进私有目录的音频副本。
     *
     * 只删 App 自己的副本，绝不碰用户的原文件；扫描设备音乐库（MediaStore）得到的歌不在
     * 这里删除，它们只是引用，用户的原文件必须保留。
     */
    /** Returns the bounded native crash trail for the settings diagnostics report. */
    @PluginMethod
    public void getCrashDiagnostics(PluginCall call) {
        CrashDiagnostics.collectHistoricalExits(getContext());
        JSObject result = new JSObject();
        result.put("history", CrashDiagnostics.read(getContext()));
        call.resolve(result);
    }

    /** Clears only the crash trail; normal app data and sessions are untouched. */
    @PluginMethod
    public void clearCrashDiagnostics(PluginCall call) {
        CrashDiagnostics.clear(getContext());
        call.resolve();
    }

    /** Stores a WebView error next to native crashes so the next diagnostic copy includes it. */
    @PluginMethod
    public void recordRuntimeDiagnostic(PluginCall call) {
        CrashDiagnostics.recordText(
            getContext(),
            call.getString("source", "webview"),
            call.getString("thread", "webview"),
            call.getString("type", "error"),
            call.getString("message", ""),
            call.getString("stack", "")
        );
        call.resolve();
    }

    @PluginMethod
    public void deleteImportedAudio(PluginCall call) {
        JSArray refs = call.getArray("refs", new JSArray());
        JSArray deleted = new JSArray();
        JSArray failed = new JSArray();
        try {
            if (localAudioServer == null) localAudioServer = new LocalAudioServer(getContext());
            File directory = localAudioServer.importedAudioDirectory();
            for (int index = 0; index < refs.length(); index += 1) {
                String ref = refs.getString(index);
                File target = resolveImportedFile(directory, ref);
                if (target == null) {
                    failed.put(ref);
                    continue;
                }
                // 已经不在了也算成功，重复删除不该被当成错误。
                if (!target.exists() || target.delete()) {
                    deleted.put(ref);
                } else {
                    failed.put(ref);
                }
            }
            JSObject result = new JSObject();
            result.put("deleted", deleted);
            result.put("failed", failed);
            call.resolve(result);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    /** 只接受 App 自己写出的 imported-* 文件名，挡掉任何路径穿越。 */
    private static File resolveImportedFile(File directory, String ref) {
        if (ref == null || !ref.startsWith("imported-")) return null;
        if (ref.contains("/") || ref.contains("\\") || ref.contains("..")) return null;
        return new File(directory, ref);
    }

    // ===== 自定义导入：选封面 / 选歌词 =====

    /** 从相册/文件中选择一张封面图，返回 data: URL（封面通常较小）。 */
    @PluginMethod
    public void pickCoverImage(PluginCall call) {
        if (isCoverPickerOpen) {
            call.reject("Cover picker is already open");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("image/*");
        isCoverPickerOpen = true;
        startActivityForResult(call, intent, "handlePickedCover");
    }

    @ActivityCallback
    private void handlePickedCover(PluginCall call, ActivityResult activityResult) {
        isCoverPickerOpen = false;
        if (call == null) return;
        int resultCode = activityResult == null ? Activity.RESULT_CANCELED : activityResult.getResultCode();
        Intent data = activityResult == null ? null : activityResult.getData();
        Uri uri = data == null ? null : data.getData();
        if (uri == null) {
            JSObject out = new JSObject();
            out.put("dataUrl", "");
            out.put("cancelled", resultCode != Activity.RESULT_OK);
            call.resolve(out);
            return;
        }
        try {
            byte[] bytes;
            try (InputStream source = getContext().getContentResolver().openInputStream(uri);
                 ByteArrayOutputStream sink = new ByteArrayOutputStream()) {
                if (source == null) throw new IOException("Cannot open cover image");
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = source.read(buffer)) != -1) sink.write(buffer, 0, read);
                bytes = sink.toByteArray();
            }
            String mime = getContext().getContentResolver().getType(uri);
            if (mime == null || mime.isEmpty()) mime = "image/jpeg";
            int semi = mime.indexOf(';');
            if (semi >= 0) mime = mime.substring(0, semi).trim();
            JSObject out = new JSObject();
            out.put("dataUrl", "data:" + mime + ";base64," + Base64.encodeToString(bytes, Base64.NO_WRAP));
            out.put("size", bytes.length);
            out.put("mime", mime);
            out.put("cancelled", false);
            call.resolve(out);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    /** 选择一个歌词文件（.lrc/.txt/.vtt/.ttml/.srt/.qrc/.krc/.fia 等），返回文本内容。 */
    @PluginMethod
    public void pickLyricFile(PluginCall call) {
        if (isLyricPickerOpen) {
            call.reject("Lyric picker is already open");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*");
        isLyricPickerOpen = true;
        startActivityForResult(call, intent, "handlePickedLyric");
    }

    @ActivityCallback
    private void handlePickedLyric(PluginCall call, ActivityResult activityResult) {
        isLyricPickerOpen = false;
        if (call == null) return;
        int resultCode = activityResult == null ? Activity.RESULT_CANCELED : activityResult.getResultCode();
        Intent data = activityResult == null ? null : activityResult.getData();
        Uri uri = data == null ? null : data.getData();
        if (uri == null) {
            JSObject out = new JSObject();
            out.put("content", "");
            out.put("fileName", "");
            out.put("cancelled", resultCode != Activity.RESULT_OK);
            call.resolve(out);
            return;
        }
        try {
            String fileName = queryDisplayName(getContext().getContentResolver(), uri);
            byte[] bytes;
            try (InputStream source = getContext().getContentResolver().openInputStream(uri);
                 ByteArrayOutputStream sink = new ByteArrayOutputStream()) {
                if (source == null) throw new IOException("Cannot open lyric file");
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = source.read(buffer)) != -1) sink.write(buffer, 0, read);
                bytes = sink.toByteArray();
            }
            JSObject out = new JSObject();
            out.put("content", new String(bytes, StandardCharsets.UTF_8));
            out.put("fileName", fileName == null ? "" : fileName);
            out.put("cancelled", false);
            call.resolve(out);
        } catch (Exception error) {
            call.reject(error.getMessage(), error);
        }
    }

    // ===== 下载音乐到本地 =====

    /** 从 URL 推断音频扩展名，无法识别时默认 .mp3。 */
    private static String audioExtensionFromUrl(String value) {
        String path = value;
        int query = path.indexOf('?');
        if (query >= 0) path = path.substring(0, query);
        int slash = path.lastIndexOf('/');
        String last = slash >= 0 ? path.substring(slash + 1) : path;
        int dot = last.lastIndexOf('.');
        if (dot <= 0 || dot >= last.length() - 1) return ".mp3";
        String ext = last.substring(dot).toLowerCase(Locale.ROOT);
        if (ext.matches("\\.(mp3|flac|wav|m4a|aac|ogg|opus|ape|wma|mp4|oga)")) return ext;
        return ".mp3";
    }

    /** 下载一个 URL 到指定文件（流式落盘，不把整文件读进内存）。 */
    private void downloadToFile(String url, File target) throws IOException {
        Request request = new Request.Builder()
            .url(url)
            .header("User-Agent", DOWNLOAD_USER_AGENT)
            .header("Accept-Encoding", "identity")
            .build();
        try (Response response = client.newCall(request).execute()) {
            ResponseBody body = response.body();
            if (!response.isSuccessful() || body == null) {
                throw new IOException("Download failed (" + response.code() + ")");
            }
            try (InputStream input = body.byteStream();
                 OutputStream output = new FileOutputStream(target)) {
                byte[] buffer = new byte[128 * 1024];
                int read;
                while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
            }
        }
    }

    /** 下载一个 URL 的字节内容（用于封面/歌词这类小文件）。 */
    private byte[] downloadBytes(String url) throws IOException {
        Request request = new Request.Builder()
            .url(url)
            .header("User-Agent", DOWNLOAD_USER_AGENT)
            .header("Accept-Encoding", "identity")
            .build();
        try (Response response = client.newCall(request).execute()) {
            ResponseBody body = response.body();
            if (!response.isSuccessful() || body == null) {
                throw new IOException("Download failed (" + response.code() + ")");
            }
            return body.bytes();
        }
    }

    /**
     * 下载音乐到本地：音频 URL（必填），封面/歌词 URL（可选）。
     * 音频以流式写入私有目录，封面返回 data: URL，歌词返回文本。
     */
    @PluginMethod
    public void downloadToLibrary(PluginCall call) {
        final String audioUrl = call.getString("audioUrl", "");
        final String coverUrl = call.getString("coverUrl", "");
        final String lyricsUrl = call.getString("lyricsUrl", "");
        if (audioUrl == null || audioUrl.isEmpty()) {
            call.reject("audioUrl is required");
            return;
        }
        final Activity activity = getActivity();
        new Thread(() -> {
            try {
                if (localAudioServer == null) localAudioServer = new LocalAudioServer(getContext());
                int port = localAudioServer.start();
                File directory = localAudioServer.importedAudioDirectory();
                String safeName = "imported-dl-" + Long.toHexString(System.currentTimeMillis())
                    + audioExtensionFromUrl(audioUrl);
                File audioFile = new File(directory, safeName);
                downloadToFile(audioUrl, audioFile);

                String coverDataUrl = "";
                if (coverUrl != null && !coverUrl.isEmpty()) {
                    try {
                        byte[] coverBytes = downloadBytes(coverUrl);
                        String mime = "image/jpeg";
                        String extension = audioExtensionFromUrl(coverUrl);
                        if (".png".equals(extension)) mime = "image/png";
                        else if (".webp".equals(extension)) mime = "image/webp";
                        else if (".gif".equals(extension)) mime = "image/gif";
                        coverDataUrl = "data:" + mime + ";base64,"
                            + Base64.encodeToString(coverBytes, Base64.NO_WRAP);
                    } catch (Exception ignored) {
                        // 封面失败不影响音频下载。
                    }
                }

                String lyricsText = "";
                if (lyricsUrl != null && !lyricsUrl.isEmpty()) {
                    try {
                        lyricsText = new String(downloadBytes(lyricsUrl), StandardCharsets.UTF_8);
                    } catch (Exception ignored) {
                        // 歌词失败不影响音频下载。
                    }
                }

                JSObject out = new JSObject();
                out.put("audioRef", safeName);
                out.put("audioUrl", "http://127.0.0.1:" + port + "/audio/" + safeName);
                out.put("fileSize", audioFile.length());
                out.put("mime", LocalAudioServer.guessMimeType(safeName));
                out.put("coverDataUrl", coverDataUrl);
                out.put("lyricsText", lyricsText);
                out.put("port", port);
                if (activity != null) activity.runOnUiThread(() -> call.resolve(out));
                else call.resolve(out);
            } catch (Exception error) {
                String message = error.getMessage() == null ? error.toString() : error.getMessage();
                if (activity != null) activity.runOnUiThread(() -> call.reject(message, error));
                else call.reject(message, error);
            }
        }, "folia-download").start();
    }

    private List<JSObject> parseCookieHeader(String header, String domain) {
        List<JSObject> cookies = new ArrayList<>();
        if (header == null || header.isEmpty()) return cookies;
        String[] pairs = header.split(";");
        for (String pair : pairs) {
            int separator = pair.indexOf('=');
            if (separator <= 0) continue;
            String name = pair.substring(0, separator).trim();
            String value = pair.substring(separator + 1).trim();
            if (name.isEmpty()) continue;
            JSObject cookie = new JSObject();
            cookie.put("name", name);
            cookie.put("value", value);
            cookie.put("domain", domain == null ? "" : domain);
            cookie.put("path", "/");
            cookie.put("secure", true);
            cookie.put("httpOnly", false);
            cookies.add(cookie);
        }
        return cookies;
    }
}
