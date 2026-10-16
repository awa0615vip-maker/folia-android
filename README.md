<p align="center">
  <img src="https://github.com/user-attachments/assets/b5d0e863-48be-497b-b0e9-4bd8d8ce9bf0" alt="Folia" width="100%" />
</p>

<div align="center">

# Folia for Android

> Lyrics Reimagined · 辞曲新境
> 把桌面端那面会呼吸的歌词墙，真正搬进你的安卓手机。

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](LICENSE)
[![Android](https://img.shields.io/badge/Android-Capacitor%20WebView-3DDC84?logo=android&logoColor=white)]()
[![Version](https://img.shields.io/badge/version-0.7.17--android.124-ff69b4)]()

</div>

---

## 这是什么

**Folia 原本是一个跑在桌面浏览器 / Electron 里的沉浸式歌词播放器**——全屏、无限延伸的海报墙，随音乐律动的文字与封面，每一次翻牌都像在翻阅实体专辑。它很美，但它从来没有官方手机版。

这个仓库是它的**非官方 Android 移植 fork**：我们把整个 React/Vite 前端塞进一个 Capacitor WebView，用自写的原生桥接住桌面端依赖的那些"浏览器里才有"的能力，让这面墙在手机上真的能转起来、能后台放歌、能锁屏切歌。

> [!IMPORTANT]
> 本项目与上游作者无关，是社区移植作品。
> - 上游：[chthollyphile/folia-major](https://github.com/chthollyphile/folia-major)
> - 许可证：**AGPL-3.0**（见 [LICENSE](LICENSE)）

---

## 它能做什么

- **完整保留原版体验**：无限海报墙、翻牌动画、全屏歌词、封面律动、播放队列——一样不少。
- **多平台在线播放**：网易云音乐扫码登录与在线播放，兼容 QQ 音乐、酷狗。
- **本地音乐**：扫描本地歌曲，封面、元数据、歌词一并识别。
- **真正的手机播放器行为**：后台播放前台服务、锁屏媒体控制、通知栏切歌。
- **离线友好**：在线封面落本地缓存，第二次进墙不重新请求。

---

## 我们走过的路：从"能跑"到"不卡"

把桌面应用搬上手机，最大的敌人不是功能，是**性能**。桌面端能随便铺满一整个 GPU 合成层，安卓 WebView 会直接跟你翻脸。这个移植经历了好几轮反复推倒重来：

**第一阶段 · 让它先在手机上活下来**
桌面端假设自己运行在 `chrome.cookies`、`chrome.storage`、完整 fetch 之上。WebView 里这些都不存在。我们写了一层 `FoliaNativeBridge`，用 Android CookieManager / OkHttp / 本地存储把桌面端的调用一个个对回去，再加上后台播放服务和锁屏媒体会话。

**第二阶段 · 跟卡顿死磕**
刚搬过来的时候，墙一滑就整屏闪烁、封面来回闪、启动慢。我们拆了重模块按需加载、把歌词动画锁帧、不可见时停掉渲染循环、长列表改成只渲染屏幕附近的卡片。

**第三阶段 · 与上游同步**
上游还在飞速更新（我们一次合并了 173 个提交、解决了近百处冲突），每一次合并都要小心保住安卓特有的桥，不被桌面分支覆盖。

**第四阶段 · 渲染策略的反复横跳**
我们试过一次性渲染全部卡片（滑动零白块，但首屏太重），也加过双指捏合缩放（手感不对，果断撤回）。最后找到的平衡点是：**首屏只渲染屏幕的 1.7 倍大小，滑过的卡片永久留在内存里**——进墙轻快，往回滑也不白块。

这一路没有什么黑科技，就是不断承认"这里不对"，然后推倒、再试。

---

## 具体优化了哪里

- **首屏代码分割**：重模块 `React.lazy` 懒加载，首屏不扛整个 JS 包。
- **渲染节流**：歌词动画锁 30fps，页面不可见 / 锁屏即停渲染。
- **封面本地持久缓存**：在线封面走 Service Worker 缓存（网易云 200MB LRU 自动淘汰，QQ/酷狗单独缓存），二次进入直接读盘。
- **海报墙增量渲染**：每次只挂载屏幕约 1.7 倍范围的卡片，渲染区域只增不减——滑过的卡片保留，不卸载、不重挂。
- **启动门**：冷启动停在启动屏，等首屏卡片挂载、封面解码完成再淡入；最多等 6 秒，不在墙页面时自动放行。
- **GPU 层改造**：相机用二维 transform 而非 translate3d，避免巨型常驻合成层反复重建造成的整屏闪烁。

---

## 构建

```bash
# 依赖：Node.js 22+、JDK 21、Android SDK
npm install
npm run build:capacitor
npx cap sync android
cd android
JAVA_HOME=/path/to/jdk21 ./gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

---

## 致谢

- 上游 [chthollyphile/folia-major](https://github.com/chthollyphile/folia-major) 与全部贡献者，没有那面墙就没有这一切。
- 所有在真机上帮忙测试、报 bug 的朋友。

## 许可证

本项目基于 AGPL-3.0 发布，沿用上游条款。任何基于本仓库的二次分发须同样开源。
