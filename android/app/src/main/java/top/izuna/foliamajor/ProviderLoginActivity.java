package top.izuna.foliamajor;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.util.TypedValue;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Random;

/**
 * 通用音乐平台「内置网页登录」：把官方网页登录页放进独立原生 WebView，
 * 登录成功后从 CookieManager 读取该平台的会话 Cookie 回传给 Web 层。
 *
 * 复用汽水音乐 QishuiLoginActivity 的成熟方案，泛化给酷狗音乐（kugou）与 QQ 音乐（qq）。
 * 登录方式与用户上周版本一致（官方账号登录），只是扫码流在安卓上无法走后端接口，
 * 改为 App 内打开官方登录页完成登录并提取 Cookie。
 *
 * 仅用于登录本人账号，不做会员破解 / DRM 绕过。
 */
public class ProviderLoginActivity extends Activity {
    public static final String EXTRA_PROVIDER = "provider";
    public static final String EXTRA_URL = "url";
    public static final String EXTRA_COOKIE = "cookie";
    public static final String EXTRA_FINAL_URL = "final_url";
    public static final String EXTRA_COOKIE_KEYS = "cookie_keys";

    // 桌面 Chrome UA：让官方页面 / 风控把设备当作 PC 端浏览器。
    private static final String DESKTOP_UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
                    + "Chrome/131.0.0.0 Safari/537.36";

    // 各平台登录页与 Cookie 判定规则（与前端各 transport 的会话键一致）。
    private static final String LOGIN_URL_KUGOU = "https://www.kugou.com/";
    private static final String LOGIN_URL_QQ = "https://y.qq.com/";

    // 酷狗匿名访问也会生成 kg_mid（设备标识），不能作为登录判定键；只有登录后才会有 token/userid。
    private static final String[] SESSION_KEYS_KUGOU = { "token", "userid" };
    // QQ 游客也有 qqmusic_key（设备键），登录判定只看真正的账号凭证。
    private static final String[] SESSION_KEYS_QQ = { "uin", "skey", "wxuin", "wxkey", "music_uin", "music_skey", "qqmusic_uin", "qqmusic_skey" };

    private static final String[] COOKIE_URLS_KUGOU = {
            "https://www.kugou.com/", "https://m.kugou.com/", "https://login-user.kugou.com/"
    };
    private static final String[] COOKIE_URLS_QQ = {
            "https://y.qq.com/", "https://c.y.qq.com/", "https://u.y.qq.com/", "https://i.y.qq.com/"
    };

    private WebView webView;
    private TextView statusText;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean finished = false;
    private int pollCount = 0;
    private String provider = "kugou";
    private String[] sessionKeys = SESSION_KEYS_KUGOU;
    private String[] cookieUrls = COOKIE_URLS_KUGOU;
    private String loginTitle = "登录酷狗音乐";
    private String initialHint = "请登录酷狗账号（支持扫码/手机号/账号密码），登录后会自动识别";

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
                statusText.setText("还没检测到登录，请完成登录后等待自动识别");
            }
            handler.postDelayed(this, 1500);
        }
    };

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        provider = getIntent().getStringExtra(EXTRA_PROVIDER);
        if (provider == null) provider = "kugou";
        if ("qq".equals(provider)) {
            sessionKeys = SESSION_KEYS_QQ;
            cookieUrls = COOKIE_URLS_QQ;
            loginTitle = "登录QQ音乐";
            initialHint = "请登录QQ账号（支持扫码/账号密码），登录后会自动识别";
        }
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
        title.setText(loginTitle);
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
                statusText.setText("还没检测到登录：请先完成登录，再点完成");
            }
        });
        bar.addView(done, new LinearLayout.LayoutParams(dp(64), ViewGroup.LayoutParams.MATCH_PARENT));

        // 状态提示行
        statusText = new TextView(this);
        statusText.setText(initialHint);
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
        }, "FoliaProviderLogin");

        String targetUrl = overrideUrl != null && !overrideUrl.isEmpty()
                ? overrideUrl : ("qq".equals(provider) ? LOGIN_URL_QQ : LOGIN_URL_KUGOU);
        webView.loadUrl(targetUrl);
        handler.postDelayed(pollRunnable, 1500);
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
            for (String url : cookieUrls) {
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
        for (String key : sessionKeys) {
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
