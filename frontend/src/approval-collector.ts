type ApprovalReply = { ok: boolean; error?: string; panelOpened?: boolean; autoStarted?: boolean };
function exchange(type: string, responseType: string, values: Record<string, unknown>, timeout = 5000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const nonce = crypto.randomUUID();
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin || event.data?.type !== responseType || event.data?.nonce !== nonce) return;
      clearTimeout(timer); window.removeEventListener('message', receive); resolve(event.data);
    };
    const timer = window.setTimeout(() => {
      window.removeEventListener('message', receive);
      reject(new Error('로그인된 Chrome과 PriceScan 검색 연결을 확인하지 못했습니다. 브라우저 연결을 켠 뒤 이 페이지를 새로고침해 주세요.'));
    }, timeout);
    window.addEventListener('message', receive);
    window.postMessage({ type, nonce, ...values }, window.location.origin);
  });
}
export async function requireApprovalCollector() {
  const result = await exchange('PRICESCAN_COLLECTOR_PING', 'PRICESCAN_COLLECTOR_PONG', {});
  if (!result.approvalFlow) throw new Error('로그인된 Chrome과 PriceScan 검색 연결이 필요합니다.');
}
export async function startApprovalCollection(query: string, productId: string, sources: string[], sourceQueries: Record<string, string> | undefined, token: string, mergeRunId = ""): Promise<ApprovalReply> {
  const response = await exchange('PRICESCAN_APPROVAL_START', 'PRICESCAN_APPROVAL_STARTED', { query, productId, sources, sourceQueries, token, mergeRunId }) as ApprovalReply;
  if (!response.ok) throw new Error(response.error || 'AI 검색을 준비하지 못했습니다. 브라우저 연결을 확인해 주세요.');
  return response;
}
