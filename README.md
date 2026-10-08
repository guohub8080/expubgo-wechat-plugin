# ExPubGo 微信助手

Chrome / Edge 浏览器扩展（Manifest V3）：把 [ExPubGo](https://guohub8080.github.io/expubgo/) 写好的文章**一键送进微信公众号编辑器**——自动填写标题、摘要、正文，并让微信图床图片在编辑器内正常预览。

## 功能

- **一键导入**：在 ExPubGo 文章页点击「发送至插件」，再到公众号编辑器（mp.weixin.qq.com）侧边的 ExPubGo 面板点「一键导入」，标题 / 摘要 / 正文 HTML 一次到位
- **图片预览修复**：微信图床（mmbiz.qpic.cn / mmbiz.qlogo.cn）有防盗链，扩展通过会话级规则为图片请求补上编辑器自身的 Referer，导入后图片即刻可见
- **双路线写入**：优先调用编辑器内容接口，接口不可用时自动回退 DOM 写入并在保存前校验
- **暂存可反复导入**：文章只存本机，可重复导入；「取消暂存」一键清除

## 安装

### 方式一：商店安装（推荐）

Edge：在 Microsoft Edge 加载项商店搜索「ExPubGo微信助手」（审核中）。

### 方式二：开发者模式加载

1. 下载本仓库代码并解压
2. 打开 `chrome://extensions`（Edge 为 `edge://extensions`），开启「开发者模式」
3. 「加载已解压」选择仓库根目录
4. 更新代码后在扩展页点「重新加载」，并**刷新所有已打开的相关页面**

## 使用

1. 在 ExPubGo 打开文章，右侧操作面板点击「发送至插件」（按钮会自动检测扩展是否已安装）
2. 打开公众号图文编辑器，页面右侧出现「ExPubGo 微信助手」面板
3. 点击「一键导入」完成填写

支持从这些页面发送：`localhost` / `127.0.0.1`（http+https）、`*.github.io` / `*.pages.dev` / `*.vercel.app` / `*.netlify.app`（托管平台的任意部署）、本地导出的单页 HTML（`file://`，需在扩展详情中开启「允许访问文件网址」）。

## 工作原理

```
ExPubGo 页面 postMessage ──► content-expubgo.js ──► chrome.storage.local.pendingInject
                                                          │ storage.onChanged 实时联动
微信公众号编辑器 ◄── content-wechat.js 侧栏面板「一键导入」┘
```

- 探测与数据通道解耦：页面通过 `expubgo-plugin-hello` 探测扩展（回执携带协议版本与扩展版本），文章数据走 `expubgo-plugin-inject`
- 微信侧正文写入优先走编辑器 JSAPI（`page-bridge.js` 主世界桥接），不可用时回退 DOM 直写 + 代码锁
- 图片防盗链由 background service worker 注册 `declarativeNetRequest` **会话规则**处理：仅对两个微信图床域名的图片请求生效、仅限白名单发起页，不拦截、不重定向、不读取任何请求内容

## 隐私

本扩展**不收集任何用户数据**：文章内容仅在本机 `chrome.storage.local` 中转，不上传、不同步、无统计、无广告、无远程代码。

## 开发

仓库无构建链，源码即产物：

```
├── manifest.json          # MV3 配置（i18n：__MSG__ + default_locale zh_CN）
├── _locales/              # zh_CN / en 文案（商店按此识别 listing 语言）
├── background.js          # Referer 会话规则（service worker）
├── content-expubgo.js     # ExPubGo 侧：hello 探测 + 文章转发
├── page-bridge.js         # 微信编辑器主世界桥接层（JSAPI）
├── content-wechat.js      # 微信侧：导入面板 + 正文写入
├── icons/                 # 扩展图标 16/32/48/128（由 SVG 生成）
├── dev/                   # pack.sh 打包 + icon.svg 矢量源 + render-icon.html 图标渲染
└── dist/                  # 打包产物（已 gitignore）
```

打包上传商店的 zip：

```bash
dev/pack.sh        # 产物：dist/expubgo-wechat-plugin-v<version>.zip（已 gitignore）
```

### 商店上架文案（提交 Partner Center / CWS 时直接粘贴，两个语言各 ≥250 字符）

**简体中文（zh-CN）**

> ExPubGo微信助手是一款为内容创作者打造的浏览器扩展，连接 ExPubGo 本地发布工具与微信公众号编辑器。在 ExPubGo 中一键即可将文章的标题、摘要与富文本正文送入公众号编辑器侧栏面板，点击「一键导入」自动填充，免去手动复制粘贴与格式错乱的烦恼。扩展同时解决微信公众号图床（mmbiz.qpic.cn / mmbiz.qlogo.cn）的防盗链问题，让文章配图在编辑器预览中正常显示；正文写入优先调用微信编辑器内部接口，兼容性与保存正确性更有保障。支持本地 localhost、GitHub Pages 以及 Cloudflare Pages / Vercel / Netlify 托管的 ExPubGo 站点。完全本地运行，不收集任何用户数据。

**English（en）**

> ExPubGo WeChat Helper bridges your ExPubGo publishing tool and the WeChat Official Account editor. With one click on the ExPubGo side, the article title, digest and rich-text body are sent straight to a sidebar panel inside the mp.weixin.qq.com editor, where one-click import fills everything in — no more manual copy-paste or broken formatting. The extension also restores preview images served by WeChat's hotlink-protected CDN (mmbiz.qpic.cn / mmbiz.qlogo.cn), so embedded pictures show up correctly while editing. Body writing prefers the editor's internal JSAPI for maximum fidelity, with a battle-tested DOM fallback. Works with ExPubGo deployed on localhost, GitHub Pages, Cloudflare Pages, Vercel and Netlify. Runs entirely locally and collects no user data.

## 免责声明

本扩展与微信 / 腾讯官方无关，ExPubGo 为独立创作工具。微信编辑器内部结构如有改版，部分功能可能需要更新适配。
