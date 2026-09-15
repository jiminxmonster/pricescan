const test = require('node:test');
const assert = require('node:assert/strict');
const { buildServerSaveRequest, sourceCaptureId } = require('../server-payload.cjs');

const task = { pageUrl: 'https://search.shopping.naver.com/search/all?query=test', warnings: [], items: [{ source: 'naver', price: 1000 }] };

test('AI-supervised marketplace results merge with a stable source-specific approval id', () => {
  const request = buildServerSaveRequest({ id: 'df561a3a-f736-415d-9e5f-4890d1da7302', query: '노트북', sortMode: 'lowest', captureMode: 'ai_supervised', mergeRunId: 'ai_123' }, 'naver', task);
  assert.equal(request.pathname, '/price-search/extension-results');
  assert.equal(request.body.merge_run_id, 'ai_123');
  assert.match(request.body.capture_id, /^[a-f0-9-]{36}$/);
  assert.equal(request.body.capture_id, sourceCaptureId('df561a3a-f736-415d-9e5f-4890d1da7302', 'naver'));
  assert.notEqual(request.body.capture_id, sourceCaptureId('df561a3a-f736-415d-9e5f-4890d1da7302', 'danawa'));
  assert.equal(request.body.approval_scope, 'server_managed_ai');
});

test('legacy desktop collection keeps its independent desktop run', () => {
  const request = buildServerSaveRequest({ id: 'df561a3a-f736-415d-9e5f-4890d1da7302', query: '노트북', sortMode: 'lowest', captureMode: 'manual_scroll' }, 'naver', task);
  assert.equal(request.pathname, '/price-search/desktop-results');
  assert.equal(request.body.collection_id, 'df561a3a-f736-415d-9e5f-4890d1da7302');
  assert.equal(request.body.merge_run_id, undefined);
});
