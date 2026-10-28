/* 问渠学堂 PPT 下载器 — background service worker
 * 负责：在页面 CORS 受限时代取图片（只在本机内存中转换）。
 */

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function fetchAsDataUrl(url, referrer) {
  const init = {
    credentials: 'include',
    cache: 'force-cache',
    headers: { Accept: 'image/avif,image/webp,image/png,image/jpeg,image/*,*/*;q=0.8' }
  };
  if (referrer) init.referrer = referrer;

  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (referrer) {
      delete init.referrer;
      response = await fetch(url, init);
    } else {
      throw error;
    }
  }

  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const buffer = await blob.arrayBuffer();
  if (!buffer.byteLength) throw new Error('响应为空');
  const type = String(blob.type || '').toLowerCase();
  if (type && !type.startsWith('image/') && type !== 'application/octet-stream') {
    throw new Error(`不是图片: ${type}`);
  }
  const finalType = type.startsWith('image/') ? type : 'image/png';
  return {
    ok: true,
    dataUrl: `data:${finalType};base64,${toBase64(buffer)}`,
    type: finalType,
    bytes: buffer.byteLength
  };
}

/* 在页面主世界（MAIN world）里读取 Vue 组件数据。
 * content script 运行在隔离世界，看不到页面挂在 DOM 上的 __vue__，
 * 因此由 background 用 chrome.scripting.executeScript 注入主世界读取。
 * 该函数会被序列化，不能引用外部变量。 */
function extractVueSlidesInPage() {
  function parseContent(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  const roots = [];
  for (const selector of ['#app', '.app-wrap', '.note-ppt_item']) {
    const node = document.querySelector(selector);
    if (node && node.__vue__) roots.push(node.__vue__);
  }
  if (!roots.length) {
    for (const node of document.querySelectorAll('*')) {
      if (node.__vue__) {
        roots.push(node.__vue__);
        break;
      }
    }
  }
  if (!roots.length) return null;

  const visited = new Set();
  function lookup(vm, depth) {
    if (!vm || depth > 60 || visited.has(vm)) return null;
    visited.add(vm);

    const candidates = [
      vm.pptList,
      vm.pptData,
      vm.ppt_list,
      vm.$props && vm.$props.pptData,
      vm.$data && vm.$data.pptList,
      vm.$data && vm.$data.pptData,
      vm.$data && vm.$data.ppt_list
    ];
    for (const candidate of candidates) {
      if (!Array.isArray(candidate) || !candidate.length) continue;
      const hasPpt = candidate.some((item) => item && (
        item.pptimgurl || item.imgSrc || item.s_imgSrc || item.pptthumb || item.content
      ));
      if (!hasPpt) continue;
      return candidate.map((item, index) => {
        const content = parseContent(item.content) || parseContent(item.ppt_content) || {};
        return {
          pptimgurl: item.pptimgurl || content.pptimgurl || content.pptImgUrl || '',
          imgSrc: item.imgSrc || content.imgSrc || '',
          pptthumb: item.pptthumb || content.pptthumb || item.s_imgSrc || content.s_imgSrc || '',
          switchTime: item.switchTime || content.switchTime || item.time || '',
          created_sec: item.created_sec ?? content.created_sec ?? index,
          order: item.order ?? item.sort ?? index
        };
      });
    }

    const children = vm.$children || [];
    for (const child of children) {
      const found = lookup(child, depth + 1);
      if (found) return found;
    }
    return null;
  }

  for (const root of roots) {
    const found = lookup(root, 0);
    if (found && found.length) return found;
  }
  return null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object') return false;

  if (message.type === 'WQXT_PING') {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return false;
  }

  if (message.type === 'WQXT_GET_VUE_SLIDES') {
    const tabId = sender?.tab?.id;
    if (!tabId) {
      sendResponse({ ok: false, error: '没有可注入的标签页' });
      return false;
    }
    chrome.scripting.executeScript(
      { target: { tabId }, world: 'MAIN', func: extractVueSlidesInPage },
      (results) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        const slides = results?.[0]?.result;
        if (Array.isArray(slides) && slides.length) {
          sendResponse({ ok: true, slides });
        } else {
          sendResponse({ ok: false, error: '页面中没有找到 PPT 数据' });
        }
      }
    );
    return true;
  }

  if (message.type === 'WQXT_FETCH_IMAGE') {
    const url = String(message.url || '');
    if (!url) {
      sendResponse({ ok: false, error: '空地址' });
      return false;
    }
    fetchAsDataUrl(url, message.referrer)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true;
  }

  return false;
});
