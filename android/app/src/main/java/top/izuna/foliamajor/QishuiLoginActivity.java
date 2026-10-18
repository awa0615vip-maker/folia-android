package top.izuna.foliamajor;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Random;

/**
 * 汽水音乐「内置 PC 扫码登录」。
 *
 * 复刻汽水 PC 客户端（SodaMusic）官方登录页的完整流程：页面内是官方 WebInterfaceSdk，
 * 用 aid=386088（luna_pc）调 passport 扫码，二维码内容是 PC 专用的 scan_login URL，并由官方
 * sdk-glue 风控 SDK 完成设备指纹/签名，因此确认后拿到的会话是真正属于 luna_pc 的、
 * 可以被 /luna/pc/me 接受的会话（而不是音乐人平台 bubble 那种 aid 不匹配的会话）。
 *
 * 官方登录页是为 Electron 写的（通过 window.transportPort 与主进程通信）。本类把它放进
 * 独立原生 WebView（file:// 来源 + 放行跨域，等价 Electron 的 file 加载 + webSecurity 豁免），
 * 并在页面内注入 transportPort shim（见 assets/qishui-login/login.html），其余扫码逻辑全部由
 * 官方 JS 完成。登录成功后从 CookieManager 读取 .qishui.com 会话 Cookie 回传给 Web 层。
 *
 * 仅用于登录本人账号，不做会员破解 / DRM 绕过。
 */
public class QishuiLoginActivity extends Activity {
    public static final String EXTRA_URL = "url";
    public static final String EXTRA_COOKIE = "cookie";
    public static final String EXTRA_FINAL_URL = "final_url";
    public static final String EXTRA_COOKIE_KEYS = "cookie_keys";
    // 官方 PC 登录页（内置 assets）；如需临时改回外部网页可传 EXTRA_URL。
    public static final String LOCAL_LOGIN_BASE = "file:///android_asset/qishui-login/login.html";
    public static final String LOGIN_ASSET = "qishui-login/login.html";
    // 桌面 Chrome UA：让官方页面 / 风控把设备当作 PC 端浏览器（与 SodaMusic 一致）。
    private static final String DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/131.0.0.0 Safari/537.36";

    // 与前端 qishuiConstants.SESSION_COOKIE_KEYS 保持一致，命中任意一个即视为已登录。
    private static final String[] SESSION_KEYS = {
        "sessionid", "sessionid_ss", "sid_tt", "sid_guard"
    };
    // 依次读取这些 URL 可见的 Cookie，覆盖父域 .qishui.com 与各子域。
    private static final String[] COOKIE_URLS = {
        "https://api.qishui.com/",
        "https://www.qishui.com/",
        "https://bff-pc.qishui.com/",
        "https://bubble.qishui.com/"
    };

    private WebView webView;
    private TextView statusText;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean finished = false;
    private int pollCount = 0;

    private final Runnable pollRunnable = new Runnable() {
        @Override
        public void run() {
            pollCount += 1;
            if (finished) return;
            LinkedHashMap<String, String> map = collectCookieMap();
            if (hasSessionKey(map)) {
                statusText.setText("已检测到登录，正在完成…");
                handler.postDelayed(() -> finishWithCookie(buildCookieHeader(collectCookieMap())), 1200);
                return;
            }
            if (pollCount == 20) {
                statusText.setText("请用最新版汽水音乐 App 扫码，登录后会自动识别");
            }
            handler.postDelayed(this, 1500);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String overrideUrl = getIntent().getStringExtra(EXTRA_URL);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.parseColor("#0B0B0D"));
        root.setLayoutParams(new ViewGroup.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // 顶部工具栏
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setBackgroundColor(Color.parseColor("#141417"));
        bar.setPadding(dp(8), 0, dp(8), 0);
        root.addView(bar, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(48)));

        Button back = new Button(this);
        back.setText("←");
        styleToolButton(back);
        back.setOnClickListener(v -> handleBack());
        bar.addView(back, new LinearLayout.LayoutParams(dp(56), ViewGroup.LayoutParams.MATCH_PARENT));

        TextView title = new TextView(this);
        title.setText("登录汽水音乐（PC 扫码）");
        title.setTextColor(Color.parseColor("#F2F2F5"));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        title.setGravity(Gravity.CENTER);
        title.setSingleLine(true);
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        Button done = new Button(this);
        done.setText("完成");
        styleToolButton(done);
        done.setOnClickListener(v -> {
            LinkedHashMap<String, String> map = collectCookieMap();
            if (hasSessionKey(map)) {
                finishWithCookie(buildCookieHeader(map));
            } else {
                statusText.setText("还没检测到登录：请先用汽水 App 扫码登录，再点完成");
            }
        });
        bar.addView(done, new LinearLayout.LayoutParams(dp(64), ViewGroup.LayoutParams.MATCH_PARENT));

        // 状态提示行
        statusText = new TextView(this);
        statusText.setText("请用最新版汽水音乐 App 扫描二维码，登录后会自动识别");
        statusText.setTextColor(Color.parseColor("#9AA0AC"));
        statusText.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
        statusText.setPadding(dp(14), dp(6), dp(14), dp(6));
        statusText.setSingleLine(false);
        root.addView(statusText, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        // WebView
        webView = new WebView(this);
        configureWebView(webView);
        root.addView(webView, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));

        setContentView(root);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        // 页面扫码成功后会调 window.close / RPC window.close，统一回这里读 cookie 判定。
        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void requestClose() {
                handler.post(() -> {
                    LinkedHashMap<String, String> map = collectCookieMap();
                    if (hasSessionKey(map)) {
                        finishWithCookie(buildCookieHeader(map));
                    } else {
                        cancelAndFinish();
                    }
                });
            }
        }, "FoliaQishuiLogin");

        if (overrideUrl != null && !overrideUrl.isEmpty()) {
            webView.loadUrl(overrideUrl);
        } else {
            loadOfficialLoginPage();
        }
        handler.postDelayed(pollRunnable, 1500);
    }

    /** 读取内置官方登录页，注入设备配置后以 file:// 来源加载（保留跨域放行）。 */
    private void loadOfficialLoginPage() {
        try {
            String html = readAsset(LOGIN_ASSET);
            JSONObject cfg = new JSONObject();
            cfg.put("deviceId", getOrCreateId("qishui_device_id"));
            cfg.put("installId", getOrCreateId("qishui_install_id"));
            cfg.put("os", "Windows");
            cfg.put("computerName", Build.MODEL != null ? Build.MODEL : "Folia");
            cfg.put("fontPrefix", "fonts");
            html = html.replace("/*__FOLIA_CONFIG_PLACEHOLDER__*/ null", cfg.toString());
            webView.loadDataWithBaseURL(
                    LOCAL_LOGIN_BASE, html, "text/html", "UTF-8", null);
        } catch (Exception e) {
            statusText.setText("登录页加载失败：" + e.getMessage());
        }
    }

    private String readAsset(String name) throws Exception {
        try (InputStream is = getAssets().open(name)) {
            ByteArrayOutputStream bos = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
            return bos.toString("UTF-8");
        }
    }

    /** 生成并持久化 19 位数字设备 / 安装 ID（字节设备 ID 为 19 位数字）。 */
    private long getOrCreateId(String key) {
        SharedPreferences sp = getSharedPreferences("folia_qishui", Context.MODE_PRIVATE);
        long v = sp.getLong(key, 0L);
        if (v == 0L) {
            long id = 1_000_000_000_000_000_000L
                    + (new Random().nextLong() >>> 1) % 9_000_000_000_000_000_000L;
            sp.edit().putLong(key, id).apply();
            return id;
        }
        return v;
    }

    private void configureWebView(WebView view) {
        WebSettings s = view.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // file:// 页面放行跨域：等价 Electron 登录窗口的 webSecurity 豁免，官方 XHR 才能带通。
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        // 桌面身份，便于官方页面 / 风控按 PC 处理。
        s.setUserAgentString(DESKTOP_UA);
        view.setWebChromeClient(new WebChromeClient());
        view.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, String u) {
                return false; // 所有链接都在当前 WebView 内打开
            }

            @Override
            public void onPageFinished(WebView v, String u) {
                super.onPageFinished(v, u);
                // 隐藏 PC 页面自带标题栏（App 已用原生工具栏）。
                v.evaluateJavascript(
                        "(function(){var st=document.createElement('style');"
                                + "st.textContent='.windows-controls{display:none!important;}';"
                                + "(document.head||document.documentElement).appendChild(st);})();",
                        null);
                if (!finished) {
                    LinkedHashMap<String, String> map = collectCookieMap();
                    if (hasSessionKey(map)) {
                        finishWithCookie(buildCookieHeader(map));
                    }
                }
            }
        });
    }

    private void styleToolButton(Button b) {
        b.setBackgroundColor(Color.TRANSPARENT);
        b.setTextColor(Color.parseColor("#F2F2F5"));
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        b.setAllCaps(false);
        b.setMinHeight(0);
        b.setMinimumHeight(0);
        b.setPadding(0, 0, 0, 0);
    }

    private void handleBack() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            cancelAndFinish();
        }
    }

    @Override
    public void onBackPressed() {
        handleBack();
    }

    private void finishWithCookie(String cookie) {
        if (finished) return;
        finished = true;
        handler.removeCallbacks(pollRunnable);
        try {
            CookieManager.getInstance().flush();
        } catch (Exception ignored) {
        }
        // flush 后可能补齐 sid_guard 等，再收集一次最新 Cookie，保证回传的 cookie 与键名一致。
        LinkedHashMap<String, String> latest = collectCookieMap();
        String finalCookie = (cookie != null && !cookie.isEmpty()) ? cookie : buildCookieHeader(latest);
        StringBuilder keys = new StringBuilder();
        for (String key : latest.keySet()) {
            if (keys.length() > 0) keys.append(',');
            keys.append(key);
        }
        String currentUrl = "";
        try {
            if (webView != null && webView.getUrl() != null) currentUrl = webView.getUrl();
        } catch (Exception ignored) {
        }
        Intent data = new Intent();
        data.putExtra(EXTRA_COOKIE, finalCookie == null ? "" : finalCookie);
        data.putExtra(EXTRA_FINAL_URL, currentUrl);
        data.putExtra(EXTRA_COOKIE_KEYS, keys.toString());
        setResult(Activity.RESULT_OK, data);
        finish();
    }

    private void cancelAndFinish() {
        if (finished) return;
        finished = true;
        handler.removeCallbacks(pollRunnable);
        setResult(Activity.RESULT_CANCELED, new Intent());
        finish();
    }

    private LinkedHashMap<String, String> collectCookieMap() {
        LinkedHashMap<String, String> map = new LinkedHashMap<>();
        try {
            CookieManager cm = CookieManager.getInstance();
            for (String url : COOKIE_URLS) {
                String header = cm.getCookie(url);
                if (header == null || header.isEmpty()) continue;
                for (String pair : header.split(";")) {
                    String p = pair.trim();
                    int eq = p.indexOf('=');
                    if (eq > 0) {
                        map.put(p.substring(0, eq).trim(), p.substring(eq + 1));
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return map;
    }

    private boolean hasSessionKey(Map<String, String> map) {
        for (String key : SESSION_KEYS) {
            if (map.containsKey(key)) return true;
        }
        return false;
    }

    private String buildCookieHeader(Map<String, String> map) {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String> e : map.entrySet()) {
            if (sb.length() > 0) sb.append("; ");
            sb.append(e.getKey()).append('=').append(e.getValue());
        }
        return sb.toString();
    }

    private int dp(int value) {
        return (int) TypedValue.applyDimension(
            TypedValue.COMPLEX_UNIT_DIP, value, getResources().getDisplayMetrics());
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacks(pollRunnable);
        if (webView != null) {
            ((ViewGroup) webView.getParent()).removeView(webView);
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
