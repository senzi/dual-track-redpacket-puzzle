(function () {
  'use strict';

  const statusEl = document.getElementById('event-status');
  const contentEl = document.getElementById('active-content');
  const humanEntry = document.getElementById('human-entry');

  async function loadStatus() {
    try {
      const response = await fetch('/api/status', { headers: { accept: 'application/json' } });
      const data = await response.json();
      const state = data.state || 'SETUP';
      statusEl.dataset.state = state;

      if (state === 'ACTIVE') {
        statusEl.textContent = '';
        contentEl.hidden = false;
        return;
      }
      if (state === 'CLAIMED') {
        statusEl.textContent = '红包已经领完，但谜题仍可继续体验。';
        contentEl.hidden = false;
        humanEntry.textContent = '继续体验 Human Track';
        return;
      }
      statusEl.textContent = '活动正在准备中，请稍后再来。';
      contentEl.hidden = true;
    } catch {
      statusEl.dataset.state = 'SETUP';
      statusEl.textContent = '暂时无法确认活动状态，请稍后刷新。';
      contentEl.hidden = true;
    }
  }

  loadStatus();
})();
