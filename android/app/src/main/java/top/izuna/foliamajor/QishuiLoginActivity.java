package top.izuna.foliamajor;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 汽水音乐「内置网页登录」：
 * 在 App 内打开一个全屏 WebView，加载汽水官方可登录网页，用户用汽水 App 扫码 / 验证码登录。
 * 登录成功后，WebView 的 CookieManager 会在 .qishui.com 域写入会话 Cookie（含 HttpOnly 的
 * sessionid / sid_tt），本页轮询检测到后，把整段 Cookie 回传给 Web 层走 importCookie 导入。
 *
 * 这样用户无需抓包、无需电脑、无需安装证书（WebView 是 App 内的正常浏览器环境，官方域名不风控）。
 * 仅用于登录本人账号，不做会员破解 / DRM 绕过。
 */
public class QishuiLoginActivity extends Activity {
    public static final String EXTRA_URL = "url";
    public static final String EXTRA_COOKIE = "cookie";
    public static final String EXTRA_FINAL_URL = "final_url";
    public static final String EXTRA_COOKIE_KEYS = "cookie_keys";
    public static final String DEFAULT_URL = "https://bubble.qishui.com/login";

    // 与前端 qishuiConstants.SESSION_COOKIE_KEYS 保持一致，命中任意一个即视为已登录。
    private static final String[] SESSION_KEYS = {
        "sessionid", "sessionid_ss", "sid_tt", "sid_guard"
    };
    // 依次读取这些 URL 可见的 Cookie，覆盖父域 .qishui.com 与各子域。
    private static final String[] COOKIE_URLS = {
        "https://api.qishui.com/",
        "https://bubble.qishui.com/",
        "https://www.qishui.com/"
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
                // 检测到会话后再等一拍，让 sid_guard 等后续 Cookie 写全，然后读最终结果返回。
                statusText.setText("已检测到登录，正在完成…");
                handler.postDelayed(() -> finishWithCookie(buildCookieHeader(collectCookieMap())), 1200);
                return;
            }
            // 长时间未检测到时给一点状态提示，不阻断用户继续操作。
            if (pollCount == 20) {
                statusText.setText("请在网页里完成登录；登录后会自动识别");
            }
            handler.postDelayed(this, 1500);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        String url = getIntent().getStringExtra(EXTRA_URL);
        if (url == null || url.isEmpty()) url = DEFAULT_URL;

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
        LinearLayout.LayoutParams barLp = new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, dp(48));
        root.addView(bar, barLp);

        Button back = new Button(this);
        back.setText("←");
        styleToolButton(back);
        back.setOnClickListener(v -> handleBack());
        bar.addView(back, new LinearLayout.LayoutParams(dp(56), ViewGroup.LayoutParams.MATCH_PARENT));

        TextView title = new TextView(this);
        title.setText("登录汽水音乐");
        title.setTextColor(Color.parseColor("#F2F2F5"));
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        title.setGravity(Gravity.CENTER);
        title.setSingleLine(true);
        LinearLayout.LayoutParams titleLp = new LinearLayout.LayoutParams(0,
            ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
        bar.addView(title, titleLp);

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
        statusText.setText("用汽水 App 扫码登录，登录后会自动识别");
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

        webView.loadUrl(url);
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
        s.setUserAgentString(s.getUserAgentString());
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
