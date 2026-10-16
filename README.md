<div align="center">

<img src="https://github.com/user-attachments/assets/b5d0e863-48be-497b-b0e9-4bd8d8ce9bf0" alt="Folia" width="100%" />

# 🎧 Folia-Android

### *Lyrics Reimagined · 辞曲新境*

#### 把桌面端那面会呼吸的歌词墙，完整搬进你的安卓手机

<br />

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL%203.0-blue.svg)](LICENSE)
[![Android](https://img.shields.io/badge/Android-Capacitor%20WebView-3DDC84?logo=android&logoColor=white)]()
[![Version](https://img.shields.io/badge/version-0.7.17--android.124-ff69b4)]()
[![Node](https://img.shields.io/badge/Node-22+-339933?logo=node.js&logoColor=white)]()
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)]()

<br />

[✨ 功能特性](#-功能特性) ·
[🛠️ 技术架构](#️-技术架构) ·
[📱 安装](#-安装) ·
[📖 开发历程](#-开发历程) ·
[⚡ 性能优化](#-性能优化) ·
[❓ FAQ](#-faq)

</div>

---

## 🌊 项目介绍

[Folia](https://github.com/chthollyphile/folia-major) 是一款跑在桌面浏览器 / Electron 上的沉浸式歌词播放器：无限延伸的专辑海报墙、随手翻牌的卡片、随音乐律动的全屏歌词——它美得像在翻实体专辑，但它**没有官方手机版**。

**Folia-Android 是我们做的安卓社区移植版。**

我们把整个前端塞进 Capacitor WebView，自己动手补齐了桌面端依赖、但手机上缺失的那一层原生能力，又针对移动端硬件做了一轮又一轮的渲染重构和性能打磨。最终，那面墙在手机上能跑了、能后台放歌了、能锁屏切歌了，而且——不卡了。

> [!IMPORTANT]
> 本项目是**社区非官方移植**，基于上游 [chthollyphile/folia-major](https://github.com/chthollyphile/folia-major)，遵循 **AGPL-3.0** 协议（见 [LICENSE](LICENSE)）。安卓容器、原生桥、后台播放与全部移动端性能优化均为我们自行实现。

---

## ✨ 功能特性

|  | 功能 | 说明 |
|---|---|---|
| 🎨 | **原版沉浸体验** | 无限海报墙、翻牌动画、全屏歌词、封面律动、播放队列——一样不少 |
| 🎵 | **多平台在线播放** | 网易云音乐扫码登录与在线播放，兼容 QQ 音乐、酷狗 |
| 📁 | **本地音乐** | 扫描手机本地音频，封面、元数据、歌词一并识别 |
| 🔒 | **后台播放** | 前台服务保活，切出去、锁屏都不停 |
| 🔔 | **锁屏媒体控制** | 通知栏 / 锁屏直接切歌、暂停 |
| 💾 | **封面离线缓存** | 在线封面落本地，二次进墙不重新请求 |
| 🚀 | **启动门** | 首屏卡片挂好、封面解码完再进入，最多 6 秒兜底 |
| 🧊 | **省电** | 锁屏 / 切后台自动停渲染，不再空转耗电 |

---

## 📸 截图

> （这里放真机截图：海报墙 / 全屏歌词 / 锁屏控制）

---

## 🛠️ 技术架构

桌面端代码写着大量 `isElectron` 分支，假设自己运行在 `chrome.cookies`、`chrome.storage`、完整 fetch 之上。我们没有改它的界面逻辑，而是在安卓这一侧把"桌面专属 API"用原生实现补了回来：

```text
┌─────────────────────────────────────────────┐
│      Folia React / Vite 前端（原样保留）        │
│   海报墙 · 歌词动画 · 播放队列 · 平台 Provider  │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│           Capacitor Android WebView          │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│   FoliaNativeBridge（自写 JS 兼容层）          │
│   chrome.cookies · chrome.storage · fetch 模拟 │
└──────────────────┬──────────────────────────┘
                   │
┌──────────────────▼──────────────────────────┐
│   FoliaNative Capacitor 插件（自写）          │
│   CookieManager · OkHttp · 前台服务 · 媒体会话 │
└─────────────────────────────────────────────┘
```

---

## 📱 安装

### 直接下载

去 [Releases](../../releases) 下载最新 APK，开启"允许安装未知来源"即可。

### 自己构建

```bash
# 依赖：Node.js 22+、JDK 21、Android SDK（compileSdk 36）
git clone https://github.com/RemnantCloudGodofWar/folia-android.git
cd folia-android
npm install
npm run build:capacitor
npx cap sync android
cd android
JAVA_HOME=/path/to/jdk21 ./gradlew assembleDebug
# 产物：android/app/build/outputs/apk/debug/app-debug.apk
```

---

## 📖 开发历程

把桌面应用搬上手机，最大的敌人从来不是功能，是**性能**。桌面端能随便铺满一整个 GPU 合成层，安卓 WebView 会直接跟你翻脸。这一路我们反复试错、推倒重来：

#### 🌱 一、让它先在手机上活下来
WebView 里没有 `chrome.cookies`、`chrome.storage`，也没有完整的浏览器网络环境。我们写了一层 `FoliaNativeBridge`，用 Android CookieManager / OkHttp / 本地存储把桌面端的调用一个个对回去，再加上后台播放前台服务和锁屏媒体会话。

#### 🩹 二、跟卡顿死磕
刚搬过来，墙一滑就整屏闪烁、封面来回闪、启动慢。我们拆了重模块按需加载、把歌词动画锁帧、不可见时停掉渲染循环、长列表改成只渲染屏幕附近的卡片。

#### 🔀 三、持续追上游
上游还在飞速更新，我们一次合并了 **173 个提交、解决了近百处冲突**，每一次合并都小心翼翼保住安卓特有的桥，不让它被桌面分支覆盖。

#### 🎛️ 四、渲染策略反复横跳
我们试过一次性渲染全部卡片（滑动零白块，但首屏太重），也加过双指捏合缩放（手感不对，果断撤回）。最后找到的平衡点是：

> **首屏只渲染屏幕的 1.7 倍大小，滑过的卡片永久留在内存里。** 进墙轻快，往回滑也不白块。

这一路没有什么黑科技，就是不断承认"这里不对"，然后推倒、再试。

---

## ⚡ 性能优化

| 优化 | 做法 | 效果 |
|---|---|---|
| 🧩 首屏代码分割 | 重模块 `React.lazy` 懒加载 | 首屏不扛整个 JS 包 |
| 🎞️ 渲染节流 | 歌词动画锁 30fps，不可见即停 | 锁屏 / 后台不再空转耗电 |
| 💿 封面本地缓存 | Service Worker 持久缓存（网易云 200MB LRU，QQ/酷狗单独缓存） | 二次进墙封面秒出 |
| 🧱 海报墙增量渲染 | 只挂屏幕 1.7 倍范围，渲染区域只增不减 | 进墙快、滑过不白块 |
| 🚪 启动门 | 等首屏卡片 + 封面就绪再进，最多 6 秒 | 不再一进来就是半加载的墙 |
| 🎨 GPU 层改造 | 相机用二维 transform 而非 translate3d | 消除整屏闪烁 |

---

## ❓ FAQ

**Q：这是官方版吗？**
A：不是，是社区非官方移植。官方桌面版在 [chthollyphile/folia-major](https://github.com/chthollyphile/folia-major)。

**Q：为什么扫码登录后部分歌曲播不了？**
A：无损、会员歌曲等受平台会员 / 地区限制，本项目不提供任何破解。

**Q：后台播放被系统杀了？**
A：把本应用加入系统后台白名单 / 电池优化豁免。

**Q：账号会泄露吗？**
A：登录凭证只存在你本机的 WebView Cookie 存储里，不上传任何服务器。

---

## 🗺️ 路线图

- [ ] 真机截图与演示视频
- [ ] Bravais 资料库墙的渲染策略对齐 Lattice
- [ ] 更细的缓存占用与清理入口
- [ ] 更多平台适配

---

## 🤝 贡献

Issue 和 PR 都欢迎。改代码前先看 [CONTRIBUTING.md](CONTRIBUTING.md)。我们的铁律：**不动外观和交互，只做底层流畅度。**

---

## 🙏 致谢

- 上游 [chthollyphile/folia-major](https://github.com/chthollyphile/folia-major) 与全部贡献者——没有那面墙，就没有这一切。
- 所有在真机上帮忙测试、报 bug 的朋友。

## ⚖️ 许可证

本项目基于 **AGPL-3.0** 发布，沿用上游条款。任何基于本仓库的二次分发须同样开源。

<br />

<div align="center">
<sub>用 ❤️ 和无数次"这里不对，推倒重来"做成</sub>
</div>
