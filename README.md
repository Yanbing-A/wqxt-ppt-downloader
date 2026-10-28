# 问渠学堂 PPT 下载器

DeepSeek生成

界面

<img width="371" height="320" alt="0c579bce-0d31-464f-ac65-7cc476947f31" src="https://github.com/user-attachments/assets/ada3b71d-b0e5-4316-939f-94807fa3a959" />



一个 **Microsoft Edge / Chrome 扩展**，用于把问渠学堂课程回放左侧的 PPT 一次性下载下来。

适用页面：

```text
https://classroom.wqxt.cdut.edu.cn/livingroom?course_id=...&sub_id=...
```

## 功能

- **打包下载 ZIP**：把整节课的幻灯片打包成一个 ZIP（图片按页编号）。
- **逐页截图（打包下载失效时可使用此功能）**：当页面只提供缩略图或原图接口不可用时，自动逐页点击左侧缩略图并截图。
- 自动检测课程页，右下角默认显示一个小「PPT」按钮，点开才是下载面板，不会遮挡视频；扩展弹窗里也能操作。
- 优先读取页面 Vue 组件里的 `pptimgurl`（原图），其次读取 `/pptnote/v1/schedule/search-ppt` 接口，最后才用缩略图/画布兜底。

> 下载的是课程回放中公开展示的幻灯片图片，不是原始 `.pptx` 文件。是否允许保存、传播，请以学校和教师的要求为准。

## 安装（Edge）

1. 下载或复制本文件夹到本机，例如：

   ```text
   C:\Users\你的用户名\Documents\wqxt-ppt-downloader
   ```

2. 打开 Edge，地址栏输入：

   ```text
   edge://extensions/
   ```

3. 打开左下角的 **开发人员模式**。
4. 点 **加载解压缩的扩展**，选择上面的文件夹（里面有 `manifest.json` 的那一层）。
5. 打开课程回放页面，右下角会出现一个小「PPT」按钮；点它才展开下载面板（默认收起，不挡视频）。

Chrome 的安装方式相同，地址是 `chrome://extensions/`。

## 使用

1. 打开课程回放，确认左侧「PPT」栏已经展开、缩略图能看到。
2. 点右下角的小「PPT」按钮展开面板，或点浏览器工具栏的扩展图标。
3. 点 **打包下载 ZIP**。
4. ZIP 会直接保存到浏览器下载目录。

ZIP 文件名：

```text
<课程名>-PPT.zip
```

ZIP 内的图片按页编号：

```text
slide-001.png
slide-002.png
...
```

## 常见问题

### 显示「未检测到 PPT」

- 先点左侧竖排的 **PPT** 标签，把缩略图栏展开；
- 等几秒让缩略图加载；
- 点面板里的 **重新检测**；
- 如果仍然不行，点 **逐页截图（打包下载失效时可使用此功能）**。

### 打包 ZIP 很慢 / 有几页失败

- 57 页原图需要逐张读取，通常要几十秒；
- 失败页会自动尝试缩略图；
- 如果大量失败，改用 **逐页截图（打包下载失效时可使用此功能）**。

### 下载的是缩略图而不是原图

- 说明页面没有把 `pptimgurl` 暴露给当前组件，或接口未返回原图；
- 此时仍会得到可读的幻灯片图片；
- 可在浏览器开发者工具中确认 `.note-ppt_item img` 的 `src` 是否已经是缩略图。

## 实现说明（给维护者）

- `content.js` / `background.js`
  - content script 在隔离世界看不到页面挂在 DOM 上的 `__vue__`，因此由 background 用 `chrome.scripting.executeScript({world:'MAIN'})` 注入读取 Vue 组件树，找 `pptList` / `pptData`，读取 `pptimgurl`、`pptthumb`、`switchTime`。
  - 调同源接口：

    ```text
    GET /pptnote/v1/schedule/search-ppt?course_id=...&sub_id=...&page=1&per_page=100
    ```

    返回 `data.list[].content` 是 JSON 字符串，里面同样有 `pptimgurl` / `pptthumb`。
  - DOM 兜底选择器：`.note-ppt_item`、`.ppt_order`、`.ppt_time`、`img`。
  - 页面画布兜底：左侧 canvas / `#ppt_canvas`。
- `background.js`
  - 提供 `WQXT_FETCH_IMAGE`，在页面 fetch 跨域失败时代取图片，只在本机内存里转换为 data URL；
  - 不再申请 `downloads` 权限，ZIP 由页面内 Blob + `<a download>` 触发，只产生一个下载文件。
- `content.js` 内置极简 ZIP 生成器（store 模式，不压缩），兼容中文文件名。
- 不读取 cookie、localStorage、token，也不向任何外部服务器发送数据。

## 目录结构

```text
wqxt-ppt-downloader/
├── manifest.json
├── background.js
├── content.js
├── popup.html
├── popup.css
├── popup.js
├── README.md
└── icons/
    ├── icon16.png
    ├── icon32.png
    ├── icon48.png
    └── icon128.png
```
