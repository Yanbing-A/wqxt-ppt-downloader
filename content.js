/* 问渠学堂 PPT 下载器 — content script
 *
 * 读取当前课程回放的 PPT 列表，支持：
 *  1) 从页面 Vue 组件数据读取原图地址（pptimgurl，优先级最高）
 *  2) 调用页面同源接口 /pptnote/v1/schedule/search-ppt
 *  3) 从左侧 .note-ppt_item 的缩略图/画布兜底
 *  4) 逐页点击 + 截图兜底
 *
 * 所有网络请求都复用当前浏览器会话；不读取、不保存、不上传任何登录凭据。
 */
(() => {
  'use strict';

  if (window.__WQXT_PPT_DOWNLOADER__) return;
  window.__WQXT_PPT_DOWNLOADER__ = true;

  const VERSION = '1.1.0';
  const state = {
    slides: [],
    source: '正在检测…',
    course: '',
    busy: false,
    mode: ''
  };

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const textOf = (el) => String(el?.textContent || '').replace(/\s+/g, ' ').trim();

  function absUrl(value) {
    if (!value) return '';
    const raw = String(value).trim();
    if (!raw || raw.startsWith('data:')) return raw;
    try {
      const url = new URL(raw, location.href);
      if (url.protocol === 'http:' && location.protocol === 'https:') url.protocol = 'https:';
      return url.href;
    } catch {
      return '';
    }
  }

  function safePart(value, fallback) {
    const cleaned = String(value || '')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    return cleaned || fallback;
  }

  function courseName() {
    if (state.course) return state.course;
    const titleNode =
      $('.header-status-base') ||
      $('.header-status-title') ||
      $('.course-title') ||
      $('h1');
    const title = textOf(titleNode) || document.title.split(/\s+-\s+/)[0] || '问渠课程';
    state.course = safePart(title.replace(/^回放\s*/, ''), '问渠课程');
    return state.course;
  }

  function parseJsonObject(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }

  function mapItem(raw, index) {
    if (!raw || typeof raw !== 'object') return null;
    const content = parseJsonObject(raw.content) || parseJsonObject(raw.ppt_content) || {};
    const merged = { ...raw, ...(content && !Array.isArray(content) ? content : {}) };

    const full = absUrl(
      merged.pptimgurl ||
      merged.pptImgUrl ||
      merged.imgSrc ||
      merged.img_url ||
      merged.imgurl ||
      merged.image ||
      merged.url
    );
    const thumb = absUrl(
      merged.pptthumb ||
      merged.pptThumb ||
      merged.s_imgSrc ||
      merged.thumb ||
      merged.thumbnail ||
      merged.cover
    );
    const time =
      merged.switchTime ||
      merged.switch_time ||
      merged.time ||
      merged.created_at ||
      '';
    const sec = Number(
      merged.created_sec ??
      merged.createdSec ??
      merged.sort ??
      merged.order ??
      index
    );

    if (!full && !thumb) return null;
    return {
      order: index + 1,
      full: full || thumb,
      thumb: thumb || full,
      time: String(time || ''),
      sec: Number.isFinite(sec) ? sec : index
    };
  }

  function dedupeAndSort(slides) {
    const seen = new Set();
    const out = [];
    for (const slide of slides) {
      if (!slide?.full) continue;
      // 同一张图在不同时间点重复出现时仍是不同页，只有完全相同的条目才去重
      const key = `${slide.full}\u0000${slide.time || ''}\u0000${slide.sec}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(slide);
    }
    out.sort((a, b) => (a.sec - b.sec) || (a.order - b.order));
    out.forEach((slide, index) => {
      slide.order = index + 1;
    });
    return out;
  }

  /* ---------- 1. Vue 组件数据（由 background 注入主世界读取） ---------- */

  async function fromVue() {
    const result = await sendMessage({ type: 'WQXT_GET_VUE_SLIDES' });
    if (!result?.ok || !Array.isArray(result.slides) || !result.slides.length) return null;
    return result.slides.map(mapItem).filter(Boolean);
  }

  /* ---------- 2. 同源接口 ---------- */

  async function fromApi() {
    const query = new URLSearchParams(location.search);
    const courseId = query.get('course_id');
    const subId = query.get('sub_id');
    if (!courseId || !subId) return null;

    const all = [];
    for (let page = 1; page <= 10; page += 1) {
      const params = new URLSearchParams({
        course_id: courseId,
        sub_id: subId,
        page: String(page),
        per_page: '100'
      });
      const response = await fetch(`/pptnote/v1/schedule/search-ppt?${params.toString()}`, {
        credentials: 'include',
        headers: { Accept: 'application/json' }
      });
      if (!response.ok) return null;
      const data = await response.json().catch(() => null);
      if (!data || !Array.isArray(data.list)) return null;
      const codeOk = data.code === 0 || data.code === 200 || data.success === true;
      if (!codeOk) return null;
      all.push(...data.list);
      if (data.list.length < 100) break;
    }

    if (!all.length) return null;
    return all.map(mapItem).filter(Boolean);
  }

  /* ---------- 3. DOM 缩略图 ---------- */

  function imageSource(img) {
    if (!img) return '';
    const values = [
      img.currentSrc,
      img.getAttribute('src'),
      img.getAttribute('data-src'),
      img.getAttribute('data-original'),
      img.getAttribute('data-lazy-src'),
      img.dataset?.src,
      img.dataset?.original
    ];
    for (const value of values) {
      if (value && !isPlaceholder(value)) return value;
    }
    return '';
  }

  function isPlaceholder(value) {
    if (!value) return true;
    const lower = String(value).toLowerCase();
    return (
      lower.startsWith('data:image/gif') ||
      (lower.startsWith('data:image/svg') && lower.length < 300) ||
      lower.includes('placeholder') ||
      lower.includes('blank.gif') ||
      lower.includes('loading.gif')
    );
  }

  function fromDom() {
    let items = $$('.note-ppt_item');
    if (!items.length) items = $$('[class*="note-ppt_item"]');
    if (!items.length) return null;

    const slides = items.map((item, index) => {
      const img = $('img', item);
      const src = imageSource(img);
      const full =
        img?.getAttribute('data-original') ||
        img?.getAttribute('data-full') ||
        img?.dataset?.original ||
        img?.dataset?.full ||
        src;
      const order = parseInt(textOf($('.ppt_order', item)), 10);
      const time = textOf($('.ppt_time', item));
      if (!src && !full) return null;
      return {
        order: Number.isFinite(order) ? order : index + 1,
        full: absUrl(full),
        thumb: absUrl(src || full),
        time,
        sec: index
      };
    }).filter(Boolean);

    if (!slides.length) return null;
    return dedupeAndSort(slides);
  }

  /* ---------- 4. 画布兜底 ---------- */

  function visibleCanvases(filter) {
    return $$('canvas').filter((canvas) => {
      if (canvas.width < 100 || canvas.height < 60) return false;
      const rect = canvas.getBoundingClientRect();
      if (rect.width < 80 || rect.height < 40) return false;
      return filter(rect);
    }).sort((a, b) => {
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return ra.top - rb.top;
    });
  }

  function fromCanvas() {
    const canvases = visibleCanvases((rect) => rect.left < window.innerWidth * 0.45);
    if (!canvases.length) return null;
    return canvases.map((canvas, index) => {
      try {
        return {
          order: index + 1,
          full: canvas.toDataURL('image/png'),
          thumb: canvas.toDataURL('image/png'),
          time: '',
          sec: index
        };
      } catch {
        return null;
      }
    }).filter(Boolean);
  }

  function mainCanvas() {
    const direct = $('#ppt_canvas');
    if (direct instanceof HTMLCanvasElement) return direct;
    const canvases = visibleCanvases((rect) => rect.left > window.innerWidth * 0.2);
    if (canvases.length) return canvases[0];
    return direct instanceof HTMLImageElement ? direct : null;
  }

  /* ---------- 汇总检测 ---------- */

  async function ensureSidebar() {
    if ($$('.note-ppt_item').length) return true;
    const candidates = $$('li, div, span, button').filter((el) => {
      const label = textOf(el);
      if (label !== 'PPT') return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.left < 130;
    });
    for (const candidate of candidates) {
      try {
        (candidate.closest('li') || candidate).click();
        await sleep(800);
        if ($$('.note-ppt_item').length) return true;
      } catch {
        // 忽略单个节点点击失败
      }
    }
    return false;
  }

  async function collectSlides(showLog = false) {
    const attempts = [];

    try {
      const vueSlides = await fromVue();
      if (vueSlides?.length) attempts.push({ source: '页面数据（原图）', slides: vueSlides });
    } catch (error) {
      console.debug('[问渠PPT] Vue 读取失败', error);
    }

    try {
      const apiSlides = await fromApi();
      if (apiSlides?.length) attempts.push({ source: '课程接口（原图）', slides: apiSlides });
    } catch (error) {
      console.debug('[问渠PPT] 接口读取失败', error);
    }

    try {
      const domSlides = fromDom();
      if (domSlides?.length) attempts.push({ source: '左侧缩略图', slides: domSlides });
    } catch (error) {
      console.debug('[问渠PPT] DOM 读取失败', error);
    }

    let chosen = attempts[0] || null;
    // 优先选择能拿到原始图的来源
    if (attempts.some((item) => item.source.includes('原图'))) {
      chosen = attempts.find((item) => item.source.includes('原图'));
    }

    if (!chosen) {
      try {
        const canvasSlides = fromCanvas();
        if (canvasSlides?.length) chosen = { source: '页面画布', slides: canvasSlides };
      } catch {
        // 忽略
      }
    }

    if (!chosen) {
      const main = mainCanvas();
      if (main) {
        try {
          const dataUrl = main instanceof HTMLCanvasElement
            ? main.toDataURL('image/png')
            : absUrl(main.currentSrc || main.src);
          if (dataUrl) chosen = { source: '当前页画布', slides: [{ order: 1, full: dataUrl, thumb: dataUrl, time: '', sec: 0 }] };
        } catch {
          // 忽略
        }
      }
    }

    if (!chosen) {
      state.slides = [];
      state.source = '未检测到 PPT';
      updatePanel();
      if (showLog) log('没有找到 PPT。请先展开左侧“PPT”栏，等缩略图加载后再点“重新检测”。', 'warn');
      return [];
    }

    state.slides = dedupeAndSort(chosen.slides);
    state.source = chosen.source;
    updatePanel();
    if (showLog) log(`已检测到 ${state.slides.length} 页（${chosen.source}）`, 'ok');
    return state.slides;
  }

  /* ---------- 下载 ---------- */

  function extensionFromUrl(url) {
    try {
      const pathname = new URL(url).pathname;
      const match = pathname.match(/\.(png|jpe?g|webp|gif|bmp|svg)$/i);
      if (!match) return '.png';
      const ext = match[1].toLowerCase();
      return ext === 'jpeg' ? '.jpg' : `.${ext}`;
    } catch {
      return '.png';
    }
  }

  function extensionFromMime(type) {
    const map = {
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/webp': '.webp',
      'image/gif': '.gif',
      'image/bmp': '.bmp',
      'image/svg+xml': '.svg'
    };
    return map[String(type || '').toLowerCase()] || '';
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  function sendMessage(message) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
            return;
          }
          resolve(response || { ok: false, error: '没有响应' });
        });
      } catch (error) {
        resolve({ ok: false, error: String(error?.message || error) });
      }
    });
  }

  async function fetchImageBlob(url) {
    if (!url) throw new Error('空地址');

    try {
      const response = await fetch(url, { credentials: 'include', cache: 'force-cache' });
      if (response.ok) {
        const blob = await response.blob();
        const type = String(blob.type || '').toLowerCase();
        if (blob.size && (!type || type.startsWith('image/') || type === 'application/octet-stream')) {
          return blob;
        }
      }
    } catch {
      // 跨域失败时走后台代取
    }

    const result = await sendMessage({
      type: 'WQXT_FETCH_IMAGE',
      url,
      referrer: location.href
    });
    if (!result?.ok || !result.dataUrl) {
      throw new Error(result?.error || '图片读取失败');
    }
    const response = await fetch(result.dataUrl);
    return await response.blob();
  }

  /* ---------- 极简 ZIP（仅存储，不压缩，兼容中文文件名） ---------- */

  let crcTable = null;
  function getCrcTable() {
    if (crcTable) return crcTable;
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      }
      crcTable[n] = c >>> 0;
    }
    return crcTable;
  }

  function crc32(bytes) {
    const table = getCrcTable();
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) {
      crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function dosDateTime(date = new Date()) {
    const year = Math.max(1980, date.getFullYear());
    const time =
      ((date.getHours() & 0x1f) << 11) |
      ((date.getMinutes() & 0x3f) << 5) |
      (Math.floor(date.getSeconds() / 2) & 0x1f);
    const day =
      (((year - 1980) & 0x7f) << 9) |
      (((date.getMonth() + 1) & 0x0f) << 5) |
      (date.getDate() & 0x1f);
    return { time, day };
  }

  function makeZip(files) {
    const encoder = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    const { time, day } = dosDateTime();

    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const data = file.data;
      const crc = crc32(data);

      const local = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0x0800, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, time, true);
      lv.setUint16(12, day, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, data.length, true);
      lv.setUint32(22, data.length, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      local.set(nameBytes, 30);

      parts.push(local, data);
      central.push({ nameBytes, crc, size: data.length, offset });
      offset += local.length + data.length;
    }

    const centralParts = [];
    let centralSize = 0;
    for (const entry of central) {
      const header = new Uint8Array(46 + entry.nameBytes.length);
      const cv = new DataView(header.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0x0800, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, time, true);
      cv.setUint16(14, day, true);
      cv.setUint32(16, entry.crc, true);
      cv.setUint32(20, entry.size, true);
      cv.setUint32(24, entry.size, true);
      cv.setUint16(28, entry.nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, entry.offset, true);
      header.set(entry.nameBytes, 46);
      centralParts.push(header);
      centralSize += header.length;
    }

    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, offset, true);
    ev.setUint16(20, 0, true);

    return new Blob([...parts, ...centralParts, end], { type: 'application/zip' });
  }

  async function downloadZip() {
    if (state.busy) return;
    await collectSlides();
    if (!state.slides.length) {
      log('没有可打包的幻灯片。', 'warn');
      return;
    }

    state.busy = true;
    state.mode = 'zip';
    setBusy(true);
    const total = state.slides.length;
    const files = [];
    let failed = 0;

    for (let index = 0; index < state.slides.length; index += 1) {
      const slide = state.slides[index];
      setProgress(index + 1, total);
      setStatus(`正在读取 ${index + 1}/${total}…`);
      let blob = null;
      try {
        blob = await fetchImageBlob(slide.full);
      } catch {
        if (slide.thumb && slide.thumb !== slide.full) {
          try {
            blob = await fetchImageBlob(slide.thumb);
          } catch {
            blob = null;
          }
        }
      }

      if (!blob) {
        failed += 1;
        continue;
      }

      const buffer = new Uint8Array(await blob.arrayBuffer());
      if (!buffer.length) {
        failed += 1;
        continue;
      }
      const ext = extensionFromMime(blob.type) || extensionFromUrl(slide.full);
      files.push({
        name: `slide-${String(index + 1).padStart(3, '0')}${ext}`,
        data: buffer
      });
    }

    if (!files.length) {
      log('ZIP 打包失败：一张图片也没能读取。请改用“逐页截图”。', 'error');
      state.busy = false;
      state.mode = '';
      setBusy(false);
      return;
    }

    setStatus('正在生成 ZIP…');
    const zip = makeZip(files);
    downloadBlob(zip, `${courseName()}-PPT.zip`);
    log(`ZIP 已生成：${files.length} 页${failed ? `，${failed} 页读取失败` : ''}。`, failed ? 'warn' : 'ok');
    setProgress(total, total);
    state.busy = false;
    state.mode = '';
    setBusy(false);
  }

  async function captureAll() {
    if (state.busy) return;
    state.busy = true;
    state.mode = 'capture';
    setBusy(true);
    log('正在逐页截图，请不要操作页面…', 'info');

    try {
      await ensureSidebar();
      const items = $$('.note-ppt_item');
      if (!items.length) throw new Error('左侧 PPT 列表未展开');

      const activeIndex = items.findIndex((item) => {
        const mask = $('.ppt_mask', item);
        return mask && getComputedStyle(mask).display !== 'none';
      });
      const files = [];
      const total = items.length;

      for (let index = 0; index < total; index += 1) {
        setProgress(index + 1, total);
        setStatus(`正在截图 ${index + 1}/${total}…`);
        const freshItems = $$('.note-ppt_item');
        (freshItems[index] || items[index])?.click();
        await sleep(650);

        const canvas = mainCanvas();
        let blob = null;
        let ext = '.png';
        if (canvas instanceof HTMLCanvasElement) {
          blob = await new Promise((resolve) => {
            try {
              canvas.toBlob((value) => resolve(value), 'image/png');
            } catch {
              resolve(null);
            }
          });
          if (!blob) {
            try {
              const dataUrl = canvas.toDataURL('image/png');
              blob = await (await fetch(dataUrl)).blob();
            } catch {
              blob = null;
            }
          }
        } else if (canvas instanceof HTMLImageElement) {
          const imageUrl = canvas.currentSrc || canvas.src;
          ext = extensionFromUrl(imageUrl);
          try {
            blob = await fetchImageBlob(imageUrl);
          } catch {
            blob = null;
          }
        }

        if (!blob) continue;
        const actualExt = extensionFromMime(blob.type) || ext;
        files.push({
          name: `slide-${String(index + 1).padStart(3, '0')}${actualExt}`,
          data: new Uint8Array(await blob.arrayBuffer())
        });
      }

      if (activeIndex >= 0) {
        const restoreItems = $$('.note-ppt_item');
        (restoreItems[activeIndex] || items[activeIndex])?.click();
      }
      if (!files.length) throw new Error('没有截到任何页面');

      setStatus('正在生成 ZIP…');
      downloadBlob(makeZip(files), `${courseName()}-PPT-截图.zip`);
      log(`逐页截图完成：${files.length}/${total} 页。`, 'ok');
    } catch (error) {
      log(`逐页截图失败：${String(error?.message || error)}`, 'error');
    } finally {
      state.busy = false;
      state.mode = '';
      setBusy(false);
    }
  }

  /* ---------- 浮动面板 ---------- */

  let panel = null;
  let els = null;

  function buildPanel() {
    if (panel) return;
    const host = document.createElement('div');
    host.id = 'wqxt-ppt-downloader-host';
    host.style.all = 'initial';
    const shadow = host.attachShadow({ mode: 'open' });

    shadow.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .panel {
          position: fixed; right: 22px; bottom: 22px; width: 330px;
          z-index: 2147483647;
          color: #eaf2ff;
          background: linear-gradient(155deg, rgba(16, 33, 58, .98), rgba(10, 20, 36, .99));
          border: 1px solid rgba(120, 180, 255, .28);
          border-radius: 16px;
          box-shadow: 0 18px 55px rgba(0, 0, 0, .42), inset 0 1px 0 rgba(255,255,255,.06);
          font: 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
          overflow: hidden;
        }
        .head { display: flex; gap: 10px; align-items: center; padding: 13px 14px 10px; }
        .badge {
          width: 35px; height: 35px; border-radius: 10px; flex: 0 0 auto;
          display: grid; place-items: center;
          background: linear-gradient(145deg, #2b7fff, #1554c7);
          box-shadow: 0 6px 16px rgba(33, 112, 255, .35);
          font-weight: 800; font-size: 12px; letter-spacing: .5px; color: #fff;
        }
        .titles { min-width: 0; flex: 1; }
        .titles b { display: block; font-size: 14px; font-weight: 700; letter-spacing: .2px; }
        .titles span { display: block; color: #8fa9c9; font-size: 11px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .min {
          all: unset; cursor: pointer; width: 24px; height: 24px; border-radius: 7px;
          color: #9db4d3; display: grid; place-items: center; font-size: 15px;
        }
        .min:hover { background: rgba(255,255,255,.08); color: #fff; }
        .meta { display: flex; gap: 8px; padding: 0 14px 9px; }
        .pill {
          font-size: 11px; color: #bcd6ff; background: rgba(46, 124, 255, .14);
          border: 1px solid rgba(83, 150, 255, .22); border-radius: 999px; padding: 3px 9px;
          max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .bar { height: 3px; margin: 0 14px 10px; background: rgba(255,255,255,.07); border-radius: 99px; overflow: hidden; }
        .bar i { display: block; width: 0%; height: 100%; background: linear-gradient(90deg, #3b8dff, #58e0c0); transition: width .25s ease; }
        .actions { display: grid; grid-template-columns: 1fr; gap: 8px; padding: 0 14px; }
        button {
          all: unset; cursor: pointer; text-align: center; border-radius: 9px;
          padding: 9px 10px; font-size: 12px; font-weight: 650; color: #dbe9ff;
          background: rgba(255,255,255,.075); border: 1px solid rgba(255,255,255,.09);
          transition: background .15s, transform .05s;
        }
        button:hover { background: rgba(255,255,255,.13); }
        button:active { transform: translateY(1px); }
        button:disabled { opacity: .45; cursor: not-allowed; }
        button.primary {
          color: #fff; background: linear-gradient(145deg, #2f86ff, #1b62df);
          border-color: rgba(130, 190, 255, .45); box-shadow: 0 6px 18px rgba(28, 100, 235, .28);
        }
        button.primary:hover { background: linear-gradient(145deg, #3d93ff, #2470ec); }
        button.wide { grid-column: 1 / -1; }
        .foot { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px 12px; gap: 8px; }
        .link { all: unset; cursor: pointer; font-size: 11px; color: #8fc0ff; }
        .link:hover { color: #c5ddff; }
        .hint { font-size: 10px; color: #6f87a4; }
        .log {
          margin: 0 14px 13px; padding: 8px 9px; max-height: 65px; overflow: auto;
          font-size: 11px; line-height: 1.4; color: #9bb4d2;
          background: rgba(0,0,0,.2); border: 1px solid rgba(255,255,255,.05); border-radius: 8px;
          white-space: pre-wrap; word-break: break-word;
        }
        .log.ok { color: #7ce3bc; }
        .log.warn { color: #ffd18a; }
        .log.error { color: #ff9b9b; }
        .mini {
          position: fixed; right: 22px; bottom: 22px; z-index: 2147483647;
          width: 44px; height: 44px; border-radius: 13px; cursor: pointer;
          display: grid; place-items: center; color: #fff; font-weight: 800; font-size: 11px;
          background: linear-gradient(145deg, #2b7fff, #1554c7);
          box-shadow: 0 10px 26px rgba(0,0,0,.4); border: 1px solid rgba(150,200,255,.4);
        }
        .hidden { display: none !important; }
      </style>
      <div class="panel hidden" id="panel">
        <div class="head">
          <div class="badge">PPT</div>
          <div class="titles"><b>问渠 PPT 下载器</b><span id="sub">正在检测幻灯片…</span></div>
          <button class="min" id="min" title="收起">—</button>
        </div>
        <div class="meta">
          <span class="pill" id="count">0 页</span>
          <span class="pill" id="source">检测中</span>
        </div>
        <div class="bar"><i id="bar"></i></div>
        <div class="actions">
          <button class="primary" id="zip">打包下载 ZIP</button>
          <button id="capture">逐页截图（打包下载失效时可使用此功能）</button>
        </div>
        <div class="foot">
          <button class="link" id="refresh">重新检测</button>
          <span class="hint">仅下载本课程</span>
        </div>
        <div class="log" id="log">打开课程回放后，会自动读取左侧 PPT。</div>
      </div>
      <div class="mini" id="mini" title="展开下载器">PPT</div>
    `;

    document.documentElement.appendChild(host);
    panel = shadow;
    els = {
      host,
      panel: shadow.getElementById('panel'),
      mini: shadow.getElementById('mini'),
      min: shadow.getElementById('min'),
      sub: shadow.getElementById('sub'),
      count: shadow.getElementById('count'),
      source: shadow.getElementById('source'),
      bar: shadow.getElementById('bar'),
      log: shadow.getElementById('log'),
      zip: shadow.getElementById('zip'),
      capture: shadow.getElementById('capture'),
      refresh: shadow.getElementById('refresh')
    };

    els.min.addEventListener('click', () => {
      els.panel.classList.add('hidden');
      els.mini.classList.remove('hidden');
    });
    els.mini.addEventListener('click', () => {
      els.mini.classList.add('hidden');
      els.panel.classList.remove('hidden');
    });
    els.zip.addEventListener('click', () => downloadZip());
    els.capture.addEventListener('click', () => captureAll());
    els.refresh.addEventListener('click', async () => {
      log('正在重新检测…', 'info');
      setStatus('正在检测幻灯片…');
      await collectSlides(true);
    });
  }

  function log(message, type = '') {
    if (!els) return;
    els.log.textContent = String(message || '');
    els.log.className = `log ${type}`.trim();
  }

  function setStatus(message) {
    if (els) els.sub.textContent = String(message || '');
  }

  function setProgress(done, total) {
    if (!els) return;
    const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    els.bar.style.width = `${percent}%`;
  }

  function setBusy(busy) {
    if (!els) return;
    for (const button of [els.zip, els.capture, els.refresh]) {
      button.disabled = busy;
    }
    if (!busy) setStatus(`${state.slides.length} 页 · ${state.source}`);
  }

  function updatePanel() {
    if (!els) return;
    els.count.textContent = `${state.slides.length} 页`;
    els.source.textContent = state.source;
    els.source.title = state.source;
    if (!state.busy) setStatus(`${state.slides.length} 页 · ${state.source}`);
  }

  async function handlePopupCommand(message, sendResponse) {
    if (!message || typeof message !== 'object') return;
    switch (message.type) {
      case 'WQXT_STATUS':
        sendResponse({
          ok: true,
          count: state.slides.length,
          source: state.source,
          course: courseName(),
          busy: state.busy,
          version: VERSION
        });
        break;
      case 'WQXT_REFRESH':
        await collectSlides(true);
        sendResponse({ ok: true, count: state.slides.length, source: state.source });
        break;
      case 'WQXT_ZIP':
        sendResponse({ ok: true });
        downloadZip();
        break;
      case 'WQXT_CAPTURE':
        sendResponse({ ok: true });
        captureAll();
        break;
      default:
        sendResponse({ ok: false, error: '未知命令' });
    }
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message !== 'object') return false;
    if (!String(message.type || '').startsWith('WQXT_')) return false;
    if (message.type === 'WQXT_STATUS' || message.type === 'WQXT_REFRESH' ||
        message.type === 'WQXT_ZIP' || message.type === 'WQXT_CAPTURE') {
      handlePopupCommand(message, sendResponse);
      return true;
    }
    return false;
  });

  async function init() {
    buildPanel();

    let attempts = 0;
    const tick = async () => {
      attempts += 1;
      const slides = await collectSlides();
      if (slides.length) {
        setStatus(`${slides.length} 页 · ${state.source}`);
        log(`已就绪：${slides.length} 页（${state.source}）。优先点“打包下载 ZIP”。`, 'ok');
        return;
      }
      if (attempts < 15) {
        setTimeout(tick, 2000);
      } else {
        setStatus('未检测到 PPT');
        log('没有找到 PPT。请展开左侧“PPT”并等缩略图加载，然后点“重新检测”。', 'warn');
      }
    };
    setTimeout(tick, 600);

    // 页面是 SPA，切换课程/小节后重新检测
    let lastUrl = location.href;
    setInterval(() => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      state.course = '';
      collectSlides();
    }, 1500);
  }

  init();
})();
