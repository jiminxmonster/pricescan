let currentState = {};
let wheelLocked = false;
window.controls.subscribe(state => {
  currentState = state;
  document.body.dataset.state = state.state || '';
  document.getElementById('title').textContent = state.title;
  document.getElementById('message').textContent = state.message;
  document.getElementById('address').textContent = state.url;
  document.getElementById('position').textContent = state.jobId === 'login' ? '로그인' : `${(state.scroll?.index || 0) + 1} / ${state.scroll?.total || 1}`;
  const track = document.getElementById('source-track');
  track.replaceChildren(...(state.scroll?.sources || []).map((item, index) => {
    const marker = document.createElement('span');
    marker.className = index === state.scroll.index ? 'active' : '';
    marker.dataset.state = item.state;
    marker.textContent = item.label;
    marker.title = `${item.label}: ${item.ready ? '수집 준비 완료' : item.state}`;
    return marker;
  }));
  for (const button of document.querySelectorAll('[data-action]')) {
    button.disabled = state.jobId === 'login' && button.dataset.action === 'resume';
    if (button.dataset.action === 'back') {
      button.hidden = state.jobId === 'login' || !state.canGoBack;
      button.disabled = !state.canGoBack;
    }
    if (button.dataset.action === 'capture-all') {
      button.hidden = state.jobId === 'login' || !state.scroll?.isLast;
      button.classList.toggle('is-working', Boolean(state.scroll?.collecting));
      button.disabled = !state.scroll?.readyCount || state.scroll?.collecting;
      button.textContent = state.scroll?.collecting ? `수집 중 ${state.scroll.collectingCount}/${state.scroll.total}`
        : state.scroll?.allReady ? `${state.scroll.total}곳 한 번에 수집`
          : state.scroll?.readyCount ? `준비된 ${state.scroll.readyCount}곳 수집` : `준비 0/${state.scroll?.total || 0}`;
    }
    if (button.dataset.action === 'cancel') button.textContent = state.jobId === 'login' ? '로그인 화면 닫기' : '수집 중지';
  }
});
document.getElementById('scroll-surface').addEventListener('wheel', async event => {
  if (currentState.jobId === 'login' || wheelLocked || Math.abs(event.deltaY) < 12) return;
  const direction = event.deltaY > 0 ? 'scroll-down' : 'scroll-up';
  if ((direction === 'scroll-down' && currentState.scroll?.isLast) || (direction === 'scroll-up' && currentState.scroll?.isFirst)) return;
  event.preventDefault();
  wheelLocked = true;
  try { await window.controls.action(direction); }
  catch (error) { document.getElementById('message').textContent = error.message; }
  finally { window.setTimeout(() => { wheelLocked = false; }, 420); }
}, { passive: false });
for (const button of document.querySelectorAll('[data-action]')) button.addEventListener('click', async () => {
  try {
    const result = await window.controls.action(button.dataset.action);
    if (button.dataset.action === 'capture-all') document.getElementById('message').textContent = `${result.count}곳의 현재 화면을 수집하고 있습니다.`;
  }
  catch (error) { document.getElementById('message').textContent = error.message; }
});
