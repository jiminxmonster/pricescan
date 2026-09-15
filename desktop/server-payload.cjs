const { createHash } = require('node:crypto');

function sourceCaptureId(jobId, source) {
  const hex = createHash('sha256').update(`${jobId}:${source}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function buildServerSaveRequest(job, source, task) {
  const common = {
    query: job.query,
    sort_mode: job.sortMode,
    page_urls: { [source]: task.pageUrl },
    warnings: task.warnings || [],
    items: task.items || [],
  };
  if (job.captureMode === 'ai_supervised' && job.mergeRunId) {
    return {
      pathname: '/price-search/extension-results',
      body: { ...common, capture_id: sourceCaptureId(job.id, source), merge_run_id: job.mergeRunId, approval_scope: 'server_managed_ai' },
    };
  }
  return {
    pathname: '/price-search/desktop-results',
    body: { ...common, collection_id: job.id, approval_scope: 'desktop_supervised' },
  };
}

module.exports = { buildServerSaveRequest, sourceCaptureId };
