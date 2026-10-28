/* 问渠学堂 PPT 下载器 — popup */
(() => {
  'use strict';

  const els = {
    dot: document.getElementById('dot'),
    status: document.getElementById('status'),
    count: document.getElementById('count'),
    source: document.getElementById('source'),
    bar: document.getElementById('bar'),
    course: document.getElementById('course'),
    zip: document.getElementById('zip'),
    capture: document.getElementById('capture'),
    refresh: document.getElementById('refresh'),
    version: document.getElementById('version')
  };

  let activeTabId = null;
  let busy = false;

  function setDot(kind) {
    els.dot.className = `dot ${kind || ''}`.trim();
  }

  function setBusy(value) {
    busy = value;
    for (const button of [els.zip, els.capture, els.refresh]) {
      button.disabled = value;
    }
  }

  function setStatus(message, kind) {
    els.status.textContent = message;
    setDot(kind);
  }

  function sendToTab(message) {
    return new Promise((resolve) => {
      if (!activeTabId) {
        resolve({ ok: false, error: '没有活动标签页' });
        return;
      }
      chrome.tabs.sendMessage(activeTabId, message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: '没有响应' });
      });
    });
  }

  async function refreshStatus() {
    setStatus('正在读取课程页面…', '');
    const result = await sendToTab({ type: 'WQXT_STATUS' });
    if (!result.ok) {
      setStatus('请先打开课程回放页面', 'warn');
      els.count.textContent = '0 页';
      els.source.textContent = '—';
      els.course.textContent = '在 classroom.wqxt.cdut.edu.cn 打开一节回放后再试。';
      setBusy(true);
      return;
    }

    setBusy(Boolean(result.busy));
    setStatus(result.count ? `已检测到 ${result.count} 页` : '暂未检测到 PPT', result.count ? 'ok' : 'warn');
    els.count.textContent = `${result.count || 0} 页`;
    els.source.textContent = result.source || '—';
    els.source.title = result.source || '';
    els.course.textContent = result.course ? `课程：${result.course}` : '';
    if (result.version) els.version.textContent = `v${result.version}`;
  }

  async function command(message, pendingText) {
    if (busy) return;
    setStatus(pendingText, '');
    const result = await sendToTab(message);
    if (!result.ok) {
      setStatus(result.error || '命令发送失败', 'err');
      return;
    }
    if (message.type === 'WQXT_ZIP') {
      setStatus('正在打包，进度会显示在页面右下角', 'ok');
    } else if (message.type === 'WQXT_CAPTURE') {
      setStatus('正在逐页截图，请不要操作页面', 'ok');
    } else if (message.type === 'WQXT_REFRESH') {
      await refreshStatus();
    }
  }

  els.zip.addEventListener('click', () => command({ type: 'WQXT_ZIP' }, '正在启动打包…'));
  els.capture.addEventListener('click', () => command({ type: 'WQXT_CAPTURE' }, '正在启动截图…'));
  els.refresh.addEventListener('click', () => command({ type: 'WQXT_REFRESH' }, '正在重新检测…'));

  (async () => {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tabs[0]?.id || null;
    if (!tabs[0]?.url?.includes('classroom.wqxt.cdut.edu.cn/livingroom')) {
      setStatus('请先打开课程回放页面', 'warn');
      els.course.textContent = '在 classroom.wqxt.cdut.edu.cn 打开一节回放后再试。';
      setBusy(true);
      return;
    }
    await refreshStatus();
  })().catch((error) => {
    setStatus(`初始化失败：${String(error?.message || error)}`, 'err');
  });
})();
