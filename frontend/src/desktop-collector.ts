export type DesktopTask = { source: string; state: string; message: string; count: number; nextAt: number | null; reused: boolean; hasScreen: boolean };
export type DesktopJob = { id: string; query: string; productId: string; active: boolean; createdAt: number; updatedAt: number; tasks: DesktopTask[] };
export type DesktopBridge = {
  version: string;
  start: (payload: { query: string; productId: string; token: string; sources: string[]; sortMode: string }) => Promise<{ id: string }>;
  list: () => Promise<DesktopJob[]>;
  authorize: (token: string) => Promise<void>;
  logout: () => Promise<void>;
  action: (jobId: string, source: string, action: 'focus' | 'resume' | 'cancel') => Promise<void>;
  loginNaver: () => Promise<void>;
  subscribe: (callback: (jobs: DesktopJob[]) => void) => () => void;
};
declare global { interface Window { PriceScanDesktop?: DesktopBridge } }
export const desktopStateLabels: Record<string, string> = {
  queued: '검색 대기', loading: '검색 중', reading: '가격 읽는 중', saving: '저장 중',
  needs_login: '로그인 필요', needs_verification: '사용자 확인 필요', needs_page: '검색 화면 확인',
  blocked: '접근 제한 · 일시정지', interrupted: '일시정지', save_failed: '저장 재시도 필요',
  completed: '완료', cancelled: '중지됨', failed: '수집 실패',
};
export const desktopAttentionStates = new Set(['needs_login', 'needs_verification', 'needs_page', 'blocked', 'interrupted', 'save_failed']);
export const desktopTerminalStates = new Set(['completed', 'cancelled', 'failed']);
export const canShowDesktopScreen = (task: Pick<DesktopTask, 'hasScreen'>) => task.hasScreen;
