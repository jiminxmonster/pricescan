const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function validPoint(target) {
  return target && Number.isFinite(target.x) && Number.isFinite(target.y)
    && target.x >= 0 && target.y >= 0;
}

async function clickVisibleTarget(webContents, target, wait = delay) {
  if (!validPoint(target)) throw new Error('화면 클릭 위치가 올바르지 않습니다.');
  const x = Math.round(target.x); const y = Math.round(target.y);
  webContents.sendInputEvent({ type: 'mouseMove', x, y, movementX: 0, movementY: 0 });
  webContents.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 });
  webContents.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 });
  await wait(120);
}

async function submitVisibleSearch(webContents, target, value, wait = delay) {
  const query = typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
  if (!validPoint(target) || !query || query.length > 300) throw new Error('검색창 입력 위치나 검색어가 올바르지 않습니다.');
  await clickVisibleTarget(webContents, target, wait);
  const modifiers = process.platform === 'darwin' ? ['meta'] : ['control'];
  webContents.sendInputEvent({ type: 'keyDown', keyCode: 'A', modifiers });
  webContents.sendInputEvent({ type: 'keyUp', keyCode: 'A', modifiers });
  webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Backspace' });
  webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Backspace' });
  await Promise.resolve(webContents.insertText(query));
  await wait(120);
  webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
}

async function scrollVisiblePage(webContents, direction, wait = delay) {
  const keyCode = direction === 'up' ? 'PageUp' : direction === 'down' ? 'PageDown' : '';
  if (!keyCode) throw new Error('화면 스크롤 방향이 올바르지 않습니다.');
  webContents.sendInputEvent({ type: 'keyDown', keyCode });
  webContents.sendInputEvent({ type: 'keyUp', keyCode });
  await wait(350);
}

module.exports = { clickVisibleTarget, submitVisibleSearch, scrollVisiblePage };
