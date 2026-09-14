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
      body: { ...common, capture_id: job.id, merge_run_id: job.mergeRunId, approval_scope: 'server_managed_ai' },
    };
  }
  return {
    pathname: '/price-search/desktop-results',
    body: { ...common, collection_id: job.id, approval_scope: 'desktop_supervised' },
  };
}

module.exports = { buildServerSaveRequest };
