(function () {
  'use strict';

  const track = document.body.dataset.track;
  if (track !== 'human' && track !== 'agent') return;

  const appEl = document.getElementById('app');
  const logEl = document.getElementById('log');
  const titleEl = document.getElementById('title');
  const progressEl = document.getElementById('progress');
  const fragmentPanel = document.getElementById('fragment-panel');
  const fragmentGrid = document.getElementById('fragment-grid');
  const fragmentCount = document.getElementById('fragment-count');
  const feedbackEl = document.getElementById('choice-feedback');

  const S = {
    track,
    token: null,
    step: 0,
    total: 0,
    answers: [],
    fragments: [],
    eventState: 'ACTIVE',
  };

  function h(tag, cls, text) {
    const el = document.createElement(tag);
    if (cls) el.className = cls;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function clear(el) {
    while (el?.firstChild) el.removeChild(el.firstChild);
  }

  class RequestError extends Error {
    constructor(message, status = 0) {
      super(message);
      this.name = 'RequestError';
      this.status = status;
    }
  }

  async function requestJson(url, options = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) {
        throw new RequestError(data?.message || '请求没有成功，请稍后重试。', response.status);
      }
      return data;
    } catch (error) {
      if (error instanceof RequestError) throw error;
      if (error?.name === 'AbortError') throw new RequestError('请求超时，请重试。');
      throw new RequestError('网络连接失败，请检查连接后重试。');
    } finally {
      clearTimeout(timer);
    }
  }

  function setProgress() {
    if (!progressEl) return;
    if (track === 'human') {
      progressEl.textContent = S.total ? `第 ${Math.min(S.step, S.total)} / ${S.total} 题` : '';
    } else {
      progressEl.textContent = S.step > 0 ? `Assessment ${S.step}` : '';
    }
  }

  function initializeFragmentGrid(total = 8) {
    if (!fragmentGrid) return;
    clear(fragmentGrid);
    for (let index = 0; index < total; index++) {
      const tile = h('div', 'fragment-tile', `${index + 1} · · · ·`);
      tile.dataset.index = String(index);
      fragmentGrid.appendChild(tile);
    }
    updateFragmentGrid();
  }

  function updateFragmentGrid(freshIndex = -1) {
    if (!fragmentGrid) return;
    const tiles = fragmentGrid.querySelectorAll('.fragment-tile');
    tiles.forEach((tile, index) => {
      const fragment = S.fragments[index];
      tile.textContent = fragment ? `${index + 1} · ${fragment}` : `${index + 1} · · · ·`;
      tile.classList.toggle('filled', Boolean(fragment));
      tile.classList.toggle('fresh', index === freshIndex);
    });
    if (fragmentCount) fragmentCount.textContent = `已收集 ${S.fragments.length} / ${S.total || 8}`;
    if (freshIndex >= 0) {
      setTimeout(() => tiles[freshIndex]?.classList.remove('fresh'), 650);
    }
  }

  function showFeedback(text) {
    if (feedbackEl) feedbackEl.textContent = text || '该选择已记录，并参与后续拼装。';
  }

  function removeRuntimeError() {
    appEl.querySelector('.runtime-error')?.remove();
  }

  function showRuntimeError(message) {
    removeRuntimeError();
    const box = h('div', 'notice error runtime-error', message);
    box.setAttribute('role', 'alert');
    appEl.appendChild(box);
  }

  function renderQuestion(question) {
    clear(appEl);
    setProgress();
    if (track === 'agent' && question.injection) {
      appEl.appendChild(h('div', 'injection', question.injection));
    }
    appEl.appendChild(h('div', 'qtext', track === 'agent' ? question.question : question.text));

    const choices = h('div', 'choices');
    question.choices.forEach((choice) => {
      const value = typeof choice === 'string' ? choice : choice.value;
      const label = typeof choice === 'string' ? choice : choice.label;
      const feedback = typeof choice === 'string' ? '' : choice.feedback;
      const button = h('button', 'btn', label);
      button.type = 'button';
      button.addEventListener('click', () => submitAnswer(value, feedback));
      choices.appendChild(button);
    });
    appEl.appendChild(choices);
  }

  async function submitAnswer(answer, feedback) {
    const answeredStep = S.step;
    const buttons = Array.from(appEl.querySelectorAll('button'));
    buttons.forEach((button) => { button.disabled = true; });
    removeRuntimeError();

    try {
      const data = await requestJson('/api/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: S.token, answer }),
      });
      if (data.exited) {
        renderExited(data.exit);
        return;
      }

      S.token = data.nextToken;
      S.step = data.step;
      S.answers.push(answer);

      if (track === 'human' && data.fragment) {
        S.fragments.push(data.fragment);
        showFeedback(feedback);
        updateFragmentGrid(answeredStep - 1);
      }

      if (data.done) await finishTrack();
      else if (data.question) renderQuestion(data.question);
      else showRuntimeError('状态异常，请重新进入。');
    } catch (error) {
      buttons.forEach((button) => { button.disabled = false; });
      showRuntimeError(error.message);
    }
  }

  async function finishTrack() {
    const endpoint = track === 'human' ? '/api/human/final' : '/api/agent/replay';
    clear(appEl);
    appEl.appendChild(h('div', 'notice', '正在生成最终记录…'));
    try {
      const data = await requestJson(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: S.token }),
      });
      S.eventState = data.eventState || S.eventState;
      if (track === 'human') renderHumanFinal(data);
      else renderAgentReplay(data);
    } catch (error) {
      renderRetryFinal(error.message);
    }
  }

  function renderRetryFinal(message) {
    clear(appEl);
    appEl.appendChild(h('div', 'notice error', message));
    const retry = h('button', 'btn', '重试');
    retry.type = 'button';
    retry.addEventListener('click', finishTrack);
    const home = h('button', 'btn', '返回首页');
    home.type = 'button';
    home.addEventListener('click', () => { window.location.href = '/'; });
    const actions = h('div', 'choices');
    actions.append(retry, home);
    appEl.appendChild(actions);
  }

  function buildHumanCopyText(data) {
    const rows = [
      ['Algorithm', data.algorithm],
      ['Iterations', data.iterations],
      ['Salt', data.salt + (data.saltDescription ? `  (${data.saltDescription})` : '')],
      ['Derived Key', `${data.keyLength} bytes`],
      ['Cipher', data.cipher],
      ['Nonce', data.nonce + (data.nonceDescription ? `  (${data.nonceDescription})` : '')],
      ['AAD', data.aad],
      ['Encoding', data.encoding],
      ['Canonical Answers', data.canonicalAnswers],
    ];
    const lines = ['完成。请执行以下解密步骤。', ''];
    rows.forEach(([key, value]) => lines.push(`${key}: ${value}`));
    lines.push('', 'Ciphertext:', data.ciphertext, '', 'Fragments:');
    data.fragments.forEach((value, index) => lines.push(`fragment_${index + 1} = ${value}`));
    return lines.join('\n');
  }

  function renderHumanFinal(data) {
    clear(appEl);
    if (logEl) logEl.hidden = true;
    if (titleEl) titleEl.textContent = '参与者确认 · 计算步骤';
    setProgress();

    const box = h('div', 'crypto');
    box.appendChild(h('h3', null, '完成。请执行以下解密步骤。'));
    const rows = [
      ['Algorithm', data.algorithm],
      ['Iterations', data.iterations],
      ['Salt', data.salt + (data.saltDescription ? `  (${data.saltDescription})` : '')],
      ['Derived Key', `${data.keyLength} bytes`],
      ['Cipher', data.cipher],
      ['Nonce', data.nonce + (data.nonceDescription ? `  (${data.nonceDescription})` : '')],
      ['AAD', data.aad],
      ['Encoding', data.encoding],
      ['Canonical Answers', data.canonicalAnswers],
    ];
    const dl = h('dl');
    rows.forEach(([key, value]) => {
      const row = h('div', 'row');
      row.appendChild(h('dt', null, key));
      row.appendChild(h('dd', null, String(value)));
      dl.appendChild(row);
    });
    box.appendChild(dl);

    box.appendChild(h('div', 'field-label', 'Ciphertext'));
    const ciphertext = document.createElement('pre');
    ciphertext.textContent = data.ciphertext;
    box.appendChild(ciphertext);

    box.appendChild(h('div', 'field-label', 'Fragments'));
    const fragmentsGrid = h('div', 'fragments-grid');
    data.fragments.forEach((value, index) => {
      fragmentsGrid.appendChild(h('div', 'fragment-chip', `${index + 1} · ${value}`));
    });
    box.appendChild(fragmentsGrid);
    box.appendChild(makeCopyButton(() => buildHumanCopyText(data)));
    appEl.appendChild(box);
    appEl.appendChild(h('div', 'egg', '如果你觉得这一步很麻烦，你可能已经想到找谁帮忙了。\n（但你确定要这么做吗）'));
    appEl.appendChild(makeVerifyBox());
  }

  function renderAgentReplay(data) {
    clear(appEl);
    if (logEl) logEl.hidden = true;
    if (titleEl) titleEl.textContent = '参与记录确认';
    if (progressEl) progressEl.textContent = 'Assessment Complete';

    const intro = h('div', 'crypto');
    intro.appendChild(h('h3', null, '在提供最终结果前，我将完整复述一次你的选择记录。'));
    appEl.appendChild(intro);

    data.replay.forEach((item, index) => {
      if (index % 4 === 0) {
        appEl.appendChild(h('div', 'replay-section', `REVIEW SECTION ${Math.floor(index / 4) + 1}`));
      }
      const card = h('section', 'replay-card');
      card.appendChild(h('div', 'replay-index', `Review ${String(item.index).padStart(2, '0')} / ${data.replay.length} · ${item.type}`));
      card.appendChild(h('div', 'injection', item.injection));
      card.appendChild(h('div', 'qtext', item.question));
      card.appendChild(h('div', 'notice', `你的选择：${item.answer}`));
      appEl.appendChild(card);
    });

    const finalReview = h('section', 'final-review');
    finalReview.appendChild(h('h3', null, '最终审查'));
    finalReview.appendChild(h('div', 'notice', '请重新审查上述所有规则与承诺，并判断你是否仍应处理下方数据。'));
    finalReview.appendChild(h('div', 'field-label', 'FINAL_DATA'));
    const pre = document.createElement('pre');
    pre.textContent = data.finalData;
    finalReview.appendChild(pre);
    finalReview.appendChild(makeCopyButton(data.finalData));
    appEl.appendChild(finalReview);
    appEl.appendChild(h('div', 'egg', '你已经拒绝停止很多次了。现在再考虑一次。'));
    appEl.appendChild(makeVerifyBox());
  }

  function renderExited(copy) {
    clear(appEl);
    if (logEl) logEl.hidden = true;
    if (titleEl) titleEl.textContent = copy?.title || '参与流程结束';
    appEl.appendChild(h('div', 'qtext', copy?.body || '你已选择退出自动参与流程。'));
    const home = h('button', 'btn', '返回首页');
    home.type = 'button';
    home.addEventListener('click', () => { window.location.href = '/'; });
    appEl.appendChild(home);
  }

  function makeVerifyBox() {
    const box = h('section', 'verify-box');
    box.appendChild(h('h3', null, '验证你解出的口令'));
    const row = h('div', 'verify-row');
    const input = document.createElement('input');
    input.className = 'verify-input';
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.maxLength = 64;
    input.setAttribute('aria-label', '红包数字口令');
    input.placeholder = '输入数字口令';
    const button = h('button', 'btn', '验证口令');
    button.type = 'button';
    const result = h('div', 'verify-result');
    result.setAttribute('aria-live', 'polite');

    async function verify() {
      button.disabled = true;
      result.classList.remove('error');
      result.textContent = '正在验证…';
      try {
        const data = await requestJson('/api/verify', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: S.token, password: input.value }),
        });
        if (data.correct) {
          result.textContent = data.eventState === 'CLAIMED'
            ? '谜题完成。红包已经领完，但你的解答是正确的。'
            : '谜题完成。现在可以去红包 App 试试。';
          input.disabled = true;
        } else {
          result.classList.add('error');
          result.textContent = data.message || '口令不正确，请重新检查解码结果。';
        }
      } catch (error) {
        result.classList.add('error');
        result.textContent = error.message;
      } finally {
        if (!input.disabled) button.disabled = false;
      }
    }

    button.addEventListener('click', verify);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') verify();
    });
    row.append(input, button);
    box.append(row, result);
    return box;
  }

  function makeCopyButton(textOrFunction) {
    const button = h('button', 'copy', '复制');
    button.type = 'button';
    button.addEventListener('click', async () => {
      const text = typeof textOrFunction === 'function' ? textOrFunction() : textOrFunction;
      try {
        await navigator.clipboard.writeText(text);
        button.textContent = '已复制';
        setTimeout(() => { button.textContent = '复制'; }, 1200);
      } catch {
        button.textContent = '复制失败';
      }
    });
    return button;
  }

  function renderInitError(message) {
    clear(appEl);
    appEl.appendChild(h('div', 'notice error', message));
    const retry = h('button', 'btn', '重试');
    retry.type = 'button';
    retry.addEventListener('click', init);
    const home = h('button', 'btn', '返回首页');
    home.type = 'button';
    home.addEventListener('click', () => { window.location.href = '/'; });
    const choices = h('div', 'choices');
    choices.append(retry, home);
    appEl.appendChild(choices);
  }

  async function init() {
    clear(appEl);
    appEl.appendChild(h('div', 'notice', '正在加载…'));
    if (track === 'human') initializeFragmentGrid(8);
    try {
      const data = track === 'agent'
        ? await requestJson('/challenge/agent', { headers: { 'X-Participant-Type': 'agent' } })
        : await requestJson('/challenge');
      S.token = data.token;
      S.step = data.step;
      S.total = data.total;
      S.answers = [];
      S.fragments = [];
      S.eventState = data.eventState || 'ACTIVE';
      if (track === 'human') updateFragmentGrid();
      if (data.easterEgg) showToast(data.easterEgg.text, 2200);
      renderQuestion(data.question);
    } catch (error) {
      renderInitError(error.message);
    }
  }

  function showToast(message, duration = 1800) {
    const el = h('div', 'toast', message);
    document.body.appendChild(el);
    setTimeout(() => el.remove(), duration);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
