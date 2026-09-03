import { useEffect, useRef, useState } from "react";
import {
  calculateSellerMargin, financeLabels, financeToDraft, groupSellerOffers, isReviewRequired,
  offerIdentity, parseFinance, safeOfferUrl, sellerSourceLabels, sellerSources,
  type FinanceDraft, type SellerOffer, type SellerProduct, type SellerSearchResult, type WatchedOffer,
} from "./seller-workspace";
import "./seller-workspace.css";
import { canShowDesktopScreen, desktopAttentionStates, desktopStateLabels, desktopTerminalStates, type DesktopJob } from "./desktop-collector";

const money = (value: number) => `${value.toLocaleString("ko-KR")}원`;
const time = (value?: string) => value ? new Date(/(?:Z|[+-]\d{2}:?\d{2})$/.test(value) ? value : `${value}Z`).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "아직 수집 전";
const emptyDraft: FinanceDraft = { sale_price: "", cost_price: "", fee_rate: "", shipping_cost: "" };
type Message = { role: "user" | "assistant"; content: string };

async function api<T>(token: string, path: string, body?: unknown, method = "POST"): Promise<T> {
  const response = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, "")}/api/seller-products${path}`, {
    method: body === undefined ? "GET" : method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(typeof data.detail === "string" ? data.detail : "요청을 처리하지 못했습니다. 입력값과 연결을 확인해 주세요.");
  }
  return response.json();
}

export default function SellerWorkspace({ token, busy, progress, selectedSources, onToggleSource, onSearch, onBrowser, onSettings, onLogout }: {
  token: string; busy: boolean; progress: string; selectedSources: string[];
  onToggleSource: (source: string) => void;
  onSearch: (query: string) => Promise<SellerSearchResult | null | undefined>;
  onBrowser: () => void; onSettings: () => void; onLogout: () => void;
}) {
  const [view, setView] = useState<"search" | "products">("search");
  const [query, setQuery] = useState("");
  const [products, setProducts] = useState<SellerProduct[]>([]);
  const [product, setProduct] = useState<SellerProduct | null>(null);
  const activeId = useRef("");
  const [fields, setFields] = useState<FinanceDraft>(emptyDraft);
  const [working, setWorking] = useState(false);
  const searchPending = useRef(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const togglePending = useRef(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const desktop = window.PriceScanDesktop;
  const [desktopJobs, setDesktopJobs] = useState<DesktopJob[]>([]);
  const desktopJob = desktopJobs.find(job => job.productId === product?.id);
  const [clock, setClock] = useState(Date.now());
  const [chatOpen, setChatOpen] = useState(false);
  const [aiConfigured, setAiConfigured] = useState(false);
  const [aiStatusLoaded, setAiStatusLoaded] = useState(false);
  const [draftQuestion, setDraftQuestion] = useState("");
  const [chats, setChats] = useState<Record<string, Message[]>>({});
  const [chatPending, setChatPending] = useState(false);
  const [chatError, setChatError] = useState("");
  const [consent, setConsent] = useState(false);
  const chatTab = useRef<HTMLButtonElement>(null);
  const chatInput = useRef<HTMLTextAreaElement>(null);
  const chatHeading = useRef<HTMLHeadingElement>(null);
  const searching = busy || working;
  const locked = searching || loading || saving || toggling;
  const financials = calculateSellerMargin(parseFinance(fields));
  const dirty = product ? JSON.stringify(fields) !== JSON.stringify(financeToDraft(product)) : false;
  const watched = product?.monitored || [];
  const result = product?.search;
  const resultSources = sellerSources.filter((source) => result?.items.some((item) => item.source === source) || selectedSources.includes(source));
  const groups = groupSellerOffers(result?.items || [], resultSources);

  const reloadList = async () => setProducts(await api<SellerProduct[]>(token, ""));
  const acceptProduct = (next: SellerProduct, resetFields = false) => {
    activeId.current = next.id;
    setProduct(next);
    setQuery(next.title);
    if (resetFields) setFields(financeToDraft(next));
    setProducts((current) => [next, ...current.filter((entry) => entry.id !== next.id)]);
  };
  const selectProduct = async (id: string) => {
    if (dirty && !window.confirm("저장하지 않은 마진 입력값이 있습니다. 저장하지 않고 이동할까요?")) return;
    activeId.current = id;
    setLoading(true); setError(""); setStatus("");
    try {
      const next = await api<SellerProduct>(token, `/${id}`);
      if (activeId.current === id) acceptProduct(next, true);
    } catch (reason) { setError((reason as Error).message); }
    finally { setLoading(false); }
  };
  useEffect(() => {
    let cancelled = false;
    api<SellerProduct[]>(token, "").then(async (rows) => {
      if (cancelled) return;
      setProducts(rows);
      if (rows[0]) {
        const initial = await api<SellerProduct>(token, `/${rows[0].id}`);
        if (!cancelled && !activeId.current) acceptProduct(initial, true);
      }
    }).catch((reason) => { if (!cancelled) setError(reason.message); });
    return () => { cancelled = true; };
  }, [token]);
  useEffect(() => {
    if (!chatOpen) return;
    chatHeading.current?.focus();
    setAiStatusLoaded(false);
    setAiConfigured(false);
    api<{configured: boolean}>(token, "/assistant/status").then((value) => setAiConfigured(value.configured))
      .catch(() => setAiConfigured(false)).finally(() => setAiStatusLoaded(true));
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") { setChatOpen(false); chatTab.current?.focus(); } };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [chatOpen, token]);
  useEffect(() => { setDraftQuestion(""); setChatError(""); setConsent(false); }, [product?.id]);
  useEffect(() => {
    if (!desktop) return;
    let alive = true;
    const update = (jobs: DesktopJob[]) => { if (alive) setDesktopJobs(jobs); };
    const unsubscribe = desktop.subscribe(update);
    void desktop.authorize(token).then(() => desktop.list()).then(update).catch(reason => { if (alive) setError(reason.message); });
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => { alive = false; unsubscribe(); window.clearInterval(timer); };
  }, [desktop, token]);
  const desktopSavedVersion = desktopJob?.tasks.filter(task => task.state === 'completed').map(task => `${task.source}:${task.count}`).join('|') || '';
  useEffect(() => {
    if (!desktopJob || !desktopSavedVersion) return;
    const id = desktopJob.productId;
    let cancelled = false;
    api<SellerProduct>(token, `/${id}`).then(next => {
      if (!cancelled && activeId.current === id) {
        // Partial results must not overwrite the next query or unsaved margin inputs.
        setProduct(next);
        setProducts(current => [next, ...current.filter(entry => entry.id !== next.id)]);
      }
    }).catch(reason => { if (!cancelled) setError(reason.message); });
    return () => { cancelled = true; };
  }, [desktopJob?.id, desktopSavedVersion, token]);
  useEffect(() => {
    const refreshImportedCurrentPage = (event: Event) => {
      const id = activeId.current;
      if (!id) return;
      const runId = String((event as CustomEvent<{ runId?: string }>).detail?.runId || "");
      const refresh = runId
        ? api<SellerProduct>(token, `/${id}/search-results`, { run_id: runId })
        : api<SellerProduct>(token, `/${id}`);
      void refresh.then(next => {
        if (activeId.current === id) {
          setProduct(next);
          setProducts(current => [next, ...current.filter(entry => entry.id !== next.id)]);
          setStatus("네이버 현재 화면 결과가 기존 가격 비교표에 합쳐졌습니다.");
        }
      }).catch(reason => setError(reason.message));
    };
    window.addEventListener("pricescan:current-page-imported", refreshImportedCurrentPage);
    return () => window.removeEventListener("pricescan:current-page-imported", refreshImportedCurrentPage);
  }, [token]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const saveFinance = async (): Promise<boolean> => {
    if (!product || financials.invalid) return false;
    setSaving(true); setError("");
    try {
      const saved = await api<SellerProduct>(token, `/${product.id}/finance`, parseFinance(fields), "PATCH");
      if (activeId.current === saved.id) acceptProduct(saved, true);
      setStatus("마진 계산 정보를 저장했습니다. 실제 쇼핑몰 판매가는 변경하지 않았습니다.");
      return true;
    } catch (reason) { setError((reason as Error).message); return false; }
    finally { setSaving(false); }
  };
  const search = async (title = query) => {
    if (!title.trim() || locked || saving || searchPending.current) return;
    if (!selectedSources.length) { setError("가격을 조사할 쇼핑몰을 하나 이상 선택하세요."); return; }
    searchPending.current = true;
    if (dirty && !(await saveFinance())) { searchPending.current = false; return; }
    setWorking(true); setError(""); setStatus("");
    try {
      const draft = await api<SellerProduct>(token, "", { title: title.trim() });
      acceptProduct(draft, true);
      setView("search");
      setStatus("내 판매상품에 등록했습니다. 필수값은 내 판매상품에서 입력하세요.");
      if (desktop) {
        await desktop.start({ query: title.trim(), productId: draft.id, token, sources: selectedSources, sortMode: 'lowest' });
        setDesktopJobs(await desktop.list());
        setStatus("독립 수집을 시작했습니다. 네이버 확인 대기 중에도 다른 쇼핑몰 결과가 먼저 표시됩니다.");
        await reloadList();
        return;
      }
      const payload = await onSearch(title.trim());
      if (payload?.run) {
        const linked = await api<SellerProduct>(token, `/${draft.id}/search-results`, { run_id: payload.run.id, warnings: payload.warnings || [] });
        if (activeId.current === draft.id) acceptProduct(linked, true);
        setStatus("검색결과를 연결했습니다. 원본을 검토하고 모니터링할 상품을 체크하세요.");
      }
      await reloadList();
    } catch (reason) { setError((reason as Error).message); }
    finally { searchPending.current = false; setWorking(false); }
  };
  const toggle = async (offer: SellerOffer, enabled: boolean) => {
    if (!product || locked || togglePending.current) return;
    togglePending.current = true;
    setToggling(true); setError("");
    try {
      const saved = await api<SellerProduct>(token, `/${product.id}/monitoring`, { item_id: offer.id, enabled });
      if (activeId.current === saved.id) acceptProduct(saved);
      setStatus(enabled ? "선택한 상품을 모니터링에 연결했습니다." : "모니터링 체크를 해제했습니다. 가격 이력은 유지됩니다.");
    } catch (reason) { setError((reason as Error).message); }
    finally { togglePending.current = false; setToggling(false); }
  };
  const sendQuestion = async () => {
    if (!product || !draftQuestion.trim() || chatPending || !consent || !aiConfigured || dirty) return;
    const id = product.id;
    const messages = [...(chats[id] || []), { role: "user" as const, content: draftQuestion.trim() }].slice(-11);
    setChatPending(true); setChatError("");
    try {
      const reply = await api<{answer: string}>(token, `/${id}/assistant`, { messages, consent: true });
      setChats((current) => ({ ...current, [id]: [...messages, { role: "assistant", content: reply.answer }] }));
      if (activeId.current === id) setDraftQuestion("");
    } catch (reason) { if (activeId.current === id) setChatError((reason as Error).message); }
    finally { setChatPending(false); }
  };

  return <div className={`seller-workspace ${view === "search" ? "is-search-view" : "is-products-view"} ${result?.run ? "has-results" : ""} ${chatOpen ? "chat-open" : ""}`}>
    <header className="seller-topbar">
      <nav aria-label="판매 작업 메뉴">
        <button aria-current={view === "search" ? "page" : undefined} onClick={() => setView("search")}>상품 검색</button>
        <button aria-current={view === "products" ? "page" : undefined} onClick={() => setView("products")}>내 판매상품 <b>{products.length}</b></button>
      </nav>
      <div className="seller-tools"><button onClick={() => desktop ? void desktop.loginNaver().catch(reason => setError(reason.message)) : onBrowser()}>{desktop ? '네이버 로그인' : '전용브라우저'}</button><button onClick={() => { if (desktop) void desktop.logout().then(onLogout).catch(reason => setError(reason.message)); else onLogout(); }}>로그아웃</button><button onClick={onSettings}>관리자설정</button></div>
    </header>
    <div className="seller-feedback" aria-live="polite">
      {error ? <p role="alert" className="seller-error">{error}</p> : <p>{status}</p>}
    </div>
    {desktop && desktopJobs.some(job => job.active || job.id === desktopJob?.id) && <section className="seller-desktop-jobs" aria-label="독립 수집 작업">
      {desktopJobs.filter(job => job.active || job.id === desktopJob?.id).map(job => <div key={job.id} className="seller-desktop-job">
        <div className="seller-section-head"><strong>{job.query}</strong><small>전용 앱 수집 · 쇼핑몰별 독립 진행</small></div>
        {job.tasks.map(task => <div key={task.source} className={`seller-desktop-task ${desktopAttentionStates.has(task.state) ? 'needs-attention' : ''}`}>
          <div><strong>{sellerSourceLabels[task.source]} · {desktopStateLabels[task.state] || task.state}</strong><p role="status">{task.message}{task.nextAt ? ` · ${Math.max(0, Math.ceil((task.nextAt - clock) / 1000))}초 남음` : ''}</p></div>
          <div className="seller-desktop-actions">
            {canShowDesktopScreen(task) && <button onClick={() => void desktop.action(job.id, task.source, 'focus').catch(reason => setError(reason.message))}>화면 보기</button>}
            {['blocked', 'interrupted', 'save_failed'].includes(task.state) && <button onClick={() => void desktop.action(job.id, task.source, 'resume').catch(reason => setError(reason.message))}>{task.state === 'save_failed' ? '저장 재시도' : '이어서 진행'}</button>}
            {!desktopTerminalStates.has(task.state) && <button onClick={() => void desktop.action(job.id, task.source, 'cancel').catch(reason => setError(reason.message))}>중지</button>}
          </div>
        </div>)}
      </div>)}
    </section>}
    {view === "search" ? <section className="seller-search-view seller-page" aria-label="상품 검색과 가격 검토">
      <h1 className="seller-sr-only">상품 가격 검색</h1>
      <form className="seller-search-form" onSubmit={(event) => { event.preventDefault(); void search(); }}>
        <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="상품명 또는 모델명" placeholder="상품명 또는 모델명" maxLength={300} disabled={locked} />
        <button disabled={locked || !query.trim()}>{searching && <i className="seller-search-button-spinner" aria-hidden="true" />}{searching ? "검색 중" : "검색"}</button>
      </form>
      <div className="seller-source-options" role="group" aria-label="가격 조사 쇼핑몰">
        {sellerSources.map((source) => <button key={source} aria-pressed={selectedSources.includes(source)} disabled={locked} onClick={() => onToggleSource(source)}><span aria-hidden="true" />{sellerSourceLabels[source]}</button>)}
      </div>
      {selectedSources.includes("naver") && !searching && <div className="seller-supervised-note"><strong>네이버 · {desktop ? '저빈도 보조 수집' : 'Chrome 현재 화면 가져오기'}</strong><span>{desktop ? '같은 검색은 6시간 재사용하고, 새 검색은 전체 기준 최소 1시간 간격으로 한 번만 실행합니다.' : '열린 네이버 결과를 직접 확인한 뒤 Chrome의 PriceScan 확장 프로그램을 누르면 현재 화면 최대 10개가 결과에 합쳐집니다.'}</span></div>}
      {product && <div className="seller-draft-banner"><span>{!product.financials.ready && <NewBadge />}<strong>{product.title}</strong> · 내 판매상품 {product.financials.ready ? "등록됨" : "필수정보 입력 대기"}</span><button onClick={() => setView("products")}>내 판매상품 보기 →</button></div>}
      {searching && <div className="seller-search-progress" role="status"><i className="seller-spinner" /><div><strong>가격 검색을 진행하고 있습니다</strong><p>{progress || "내 판매상품을 준비하고 있습니다…"}</p></div></div>}
      {!busy && progress && <p className="seller-caption" role="status">{progress}</p>}
      {result?.run && <div className={searching ? "seller-results is-updating" : "seller-results"} aria-busy={searching}>
        <div className="seller-section-head"><h2>쇼핑몰별 최저가</h2><time>{time(result.run.created_at)} 기준{searching ? " · 이전 결과" : ""}</time></div>
        <div className="seller-market-summary">{groups.map((group) => <a href={`#offers-${group.source}`} key={group.source}><span>{sellerSourceLabels[group.source]}</span><strong>{group.lowest ? money(group.lowest.total) : "확인 필요"}</strong><small>{group.lowest ? `${group.lowest.mall} · 배송비 포함` : "유효한 가격이 없습니다"}</small><PriceRange items={group.rows.filter((row) => !isReviewRequired(row))} /></a>)}</div>
        <p className="seller-caption">파서가 감지한 최저가 후보입니다. 동일 모델·옵션과 배송 조건은 원본에서 검토해 주세요.</p>
        {result.warnings?.map((warning, index) => <p className="seller-review-note" key={index}>{warning}</p>)}
        {groups.map((group) => <OfferSection key={`${result.run?.id}-${group.source}`} source={group.source} rows={group.rows} watched={watched} disabled={locked || toggling} onToggle={toggle} />)}
      </div>}
      {!result?.run && !searching && product && <div className="seller-empty">수집이 완료되면 쇼핑몰별 최저가와 상품 링크가 여기에 표시됩니다.</div>}
    </section> : <section className="seller-products-view seller-page" aria-label="내 판매상품">
      <div className="seller-section-head"><h1>내 판매상품</h1><button onClick={() => setView("search")}>← 상품 검색</button></div>
      {products.length === 0 ? <div className="seller-empty"><h2>아직 내 판매상품이 없습니다</h2><p>상품명을 검색하면 신규 상품이 자동으로 등록됩니다.</p><button onClick={() => setView("search")}>첫 상품 검색하기</button></div> : <>
        <div className="seller-product-picker" role="group" aria-label="내 판매상품 선택">{products.map((entry) => <button key={entry.id} className={entry.id === product?.id ? "active" : ""} disabled={locked || saving} aria-pressed={entry.id === product?.id} onClick={() => void selectProduct(entry.id)}>{!entry.financials.ready && <NewBadge />}<span>{entry.title}</span><small>모니터링 {entry.monitored_count}</small></button>)}</div>
        {product && <>
          <section className="seller-fixed-product" aria-label="고정 판매상품과 마진 계산">
            <div className="seller-owned-heading"><div><span>내 판매상품 {!product.financials.ready && <NewBadge />}</span><h2>{product.title}</h2></div><div><small>최근 조사 {time(result?.run?.created_at)}</small><button disabled={locked || saving} onClick={() => void search(product.title)}>전체 재검색</button></div></div>
            <div className="seller-finance-fields">{(Object.keys(financeLabels) as (keyof FinanceDraft)[]).map((key) => <label key={key}><span>{financeLabels[key]} <b>*</b></span><div><input type="number" inputMode="decimal" aria-label={financeLabels[key]} min={key === "sale_price" ? 1 : 0} max={key === "fee_rate" ? 99.99 : 10_000_000_000} step={key === "fee_rate" ? "0.01" : "1"} placeholder={key === "fee_rate" ? "예: 8" : "직접 입력"} value={fields[key]} disabled={saving || locked} onChange={(event) => setFields((current) => ({ ...current, [key]: event.target.value }))} /><em>{key === "fee_rate" ? "%" : "원"}</em></div></label>)}</div>
            <div className={`seller-margin-bar ${financials.ready && financials.profit! < 0 ? "is-loss" : ""}`} aria-live="polite">
              <div><span>건당 예상이익</span><strong>{financials.ready ? money(financials.profit!) : "계산 전"}</strong></div><div><span>매출 기준 마진율</span><strong>{financials.ready ? `${financials.marginRate!.toFixed(2)}%` : "—"}</strong></div>
              <p>{financials.invalid ? "금액은 0 이상 정수, 판매가는 1원 이상, 수수료는 100% 미만으로 입력하세요." : financials.ready ? `수수료 ${money(financials.fee!)} 반영 · 실제 판매가 변경 아님` : `${financials.missing.map((key) => financeLabels[key]).join(" · ")} 입력 필요`}</p>
              <button className="seller-primary" disabled={saving || locked || !dirty || financials.invalid} onClick={() => void saveFinance()}>{saving ? "저장 중…" : dirty ? "입력값 저장" : "저장됨"}</button>
            </div>
            <small className="seller-caption">판매가 − 매입 원가 − 판매가 기준 수수료 − 판매자 부담 배송비. 미입력과 0원은 구분됩니다. 세금·반품비 등은 별도 고려하세요.</small>
          </section>
          <div className="seller-monitor-scroll" role="region" tabIndex={0} aria-label="모니터링 상품 스크롤 영역">
            <div className="seller-section-head"><h2>모니터링 상품 <b>{watched.length}</b></h2><small>전체 재검색 시 새 경쟁상품도 확인합니다</small></div>
            {watched.length === 0 ? <div className="seller-empty"><p>검색결과에서 비교할 상품을 체크해 주세요.</p><button onClick={() => setView("search")}>경쟁상품 검토하기 →</button></div> : <div className="seller-watch-list">{watched.map((offer) => <article key={offer.offer_key}>
              <div className="seller-watch-info"><small>{sellerSourceLabels[offer.source]} · {offer.mall}</small><a href={safeOfferUrl(offer.url)} target="_blank" rel="noreferrer">{offer.name} ↗</a><span>{time(offer.collected_at)} 관측{!offer.seen_in_latest && " · 이번 검색에서 미발견, 이전 가격"}</span>{isReviewRequired(offer) && <em>검토 필요: {offer.exclusion_reason || "가격/상품 일치 확인"}</em>}</div>
              <div className="seller-watch-price"><strong>{money(offer.total)}</strong><small>상품 {money(offer.price)} + 배송 {money(offer.shipping)}</small><button disabled={saving || locked || !offer.seen_in_latest || isReviewRequired(offer)} onClick={() => { setFields((current) => ({ ...current, sale_price: String(offer.price) })); setStatus("경쟁상품의 상품가를 판매가 입력란에 대입했습니다. 실제 가격은 변경되지 않습니다."); }}>이 상품가로 마진 계산</button></div>
              <HistoryChart offer={offer} />
              <label className="seller-monitor-check"><input type="checkbox" checked disabled={toggling || locked} aria-label={`${offer.mall} ${offer.name} 모니터링`} onChange={() => void toggle(offer, false)} /><span>모니터링</span></label>
            </article>)}</div>}
          </div>
        </>}
      </>}
    </section>}
    <button ref={chatTab} className="seller-ai-tab" aria-expanded={chatOpen} aria-controls="seller-ai-panel" onClick={() => setChatOpen((open) => !open)}><span>✦</span> AI 상담</button>
    {chatOpen && <aside id="seller-ai-panel" className="seller-ai-panel" aria-label="AI 가격 상담">
      <header><div><span>PRICE ASSISTANT</span><h2 ref={chatHeading} tabIndex={-1}>가격을 함께 검토해요</h2></div><button aria-label="AI 채팅 닫기" onClick={() => { setChatOpen(false); chatTab.current?.focus(); }}>×</button></header>
      <div className="seller-ai-context"><span>현재 상품</span><strong>{product?.title || "먼저 상품을 검색해 주세요"}</strong><small>{aiStatusLoaded ? aiConfigured ? "DeepSeek 설정됨 · 저장한 상품 기준" : "AI 미연결 · API 설정 필요" : "AI 연결 확인 중…"}</small></div>
      <div className="seller-ai-messages" role="log" aria-live="polite">{product && (chats[product.id] || []).map((message, index) => <div key={index} className={`seller-chat-message ${message.role}`}><small>{message.role === "user" ? "나" : "AI"}</small><p>{message.content}</p></div>)}
        {(!product || !chats[product.id]?.length) && <div className="seller-ai-welcome"><p>가격을 낮췄을 때 남는 이익과 경쟁상품의 차이를 질문할 수 있습니다.</p><button disabled={!aiConfigured || !product} onClick={() => { setDraftQuestion("모니터링 상품 가격에 맞추면 내 이익이 얼마나 남을까요?"); chatInput.current?.focus(); }}>경쟁가격으로 바꾸면 얼마가 남나요? ↗</button>{aiStatusLoaded && !aiConfigured && <p>아직 AI API 키·모델이 설정되지 않았습니다. 연결 전에는 질문을 전송하지 않으며, 마진 계산은 AI 없이 바로 사용할 수 있습니다.</p>}</div>}
        {chatPending && <p role="status">답변을 기다리고 있습니다…</p>}{chatError && <p role="alert" className="seller-error">{chatError}</p>}
      </div>
      <form className="seller-ai-compose" onSubmit={(event) => { event.preventDefault(); void sendQuestion(); }}>
        <label className="seller-ai-consent"><input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} disabled={!aiConfigured} />질문 시 선택 상품의 원가·판매가·수수료·배송비와 모니터링 정보를 DeepSeek에 전송하는 데 동의합니다.</label>
        {dirty && <small>입력값을 저장한 뒤 질문해 주세요.</small>}
        <textarea ref={chatInput} aria-label="AI에게 질문" placeholder={aiConfigured ? "가격과 마진에 대해 질문하세요" : "AI 연결 후 사용할 수 있습니다"} value={draftQuestion} maxLength={2000} disabled={!aiConfigured || !product || chatPending} onChange={(event) => setDraftQuestion(event.target.value)} />
        <button className="seller-primary" disabled={!aiConfigured || !product || !consent || chatPending || !draftQuestion.trim() || dirty}>질문 보내기</button><small>AI는 가격을 변경하지 않습니다. 최종 결정은 판매자가 합니다.</small>
      </form>
    </aside>}
  </div>;
}

function NewBadge() { return <b className="seller-new-badge" title="신규 · 마진 필수정보 미입력" aria-label="신규 정보 미입력">N</b>; }
function PriceRange({ items }: { items: SellerOffer[] }) {
  if (!items.length) return <div className="seller-range-empty" />;
  const prices = items.slice(0, 10).map((item) => item.total);
  const min = Math.min(...prices), max = Math.max(...prices);
  return <div className="seller-price-range" role="img" aria-label={`감지 가격 범위 ${money(min)}에서 ${money(max)}`}><div />{prices.map((price, index) => <i key={index} style={{ left: `${max === min ? 50 : 4 + (price - min) / (max - min) * 92}%` }} />)}</div>;
}
function HistoryChart({ offer }: { offer: WatchedOffer }) {
  const prices = offer.history.map((point) => point.total);
  if (prices.length < 2) return <div className="seller-history-empty">가격 이력 1회<br /><small>재검색 후 추이 표시</small></div>;
  const min = Math.min(...prices), max = Math.max(...prices);
  const dates = offer.history.map((point) => Date.parse(point.collected_at));
  const elapsed = dates[dates.length - 1] - dates[0];
  return <div className="seller-history" role="img" aria-label={`${offer.mall} 가격 변화 ${money(prices[0])}에서 ${money(prices[prices.length - 1])}`}><svg viewBox="0 0 150 48"><polyline points={prices.map((price, index) => `${4 + (elapsed > 0 ? (dates[index] - dates[0]) / elapsed : index / (prices.length - 1)) * 142},${max === min ? 24 : 42 - (price - min) / (max - min) * 36}`).join(" ")} /></svg><small>{time(offer.history[0].collected_at)} → {time(offer.history[offer.history.length - 1]?.collected_at)}</small></div>;
}
function OfferSection({ source, rows, watched, disabled, onToggle }: { source: string; rows: SellerOffer[]; watched: WatchedOffer[]; disabled: boolean; onToggle: (offer: SellerOffer, enabled: boolean) => void }) {
  const [expanded, setExpanded] = useState(false);
  const monitored = new Set(watched.map(offerIdentity));
  const visible = expanded ? rows : rows.slice(0, 10);
  return <section id={`offers-${source}`} className="seller-offer-section" aria-label={`${sellerSourceLabels[source]} 가격 검토`}>
    <div className="seller-section-head"><h2>{sellerSourceLabels[source]} <b>{rows.length}</b></h2><span>배송비 포함 가격순 · 원본 검토 필요</span></div>
    {rows.length < 5 && <p className="seller-review-note">{rows.length ? `${rows.length}개만 감지되었습니다. 5개 미만의 결과만 있어 추가 확인이 필요합니다.` : "감지된 결과가 없습니다. 차단·로그인·검색어 또는 파서 상태를 확인해 주세요."}</p>}
    {visible.length > 0 && <div className="seller-offer-table"><table><thead><tr><th>후보</th><th>상품 / 옵션 검토</th><th>판매자</th><th>상품가</th><th>배송비</th><th>배송비 포함</th><th>모니터링</th></tr></thead><tbody>{visible.map((offer, index) => <tr key={offer.id} className={`${monitored.has(offerIdentity(offer)) ? "is-monitored" : ""} ${isReviewRequired(offer) ? "needs-review" : ""}`}>
      <td>{String(index + 1).padStart(2, "0")}</td><td><a href={safeOfferUrl(offer.url)} target="_blank" rel="noreferrer">{offer.name} ↗</a>{isReviewRequired(offer) && <small className="seller-review-flag">검토 필요 · {offer.exclusion_reason || "비정상 가격 또는 링크 확인"}</small>}<small>{offer.extraction_methods?.join(" · ") || "화면에서 감지한 가격"}{offer.collected_at ? ` · ${time(offer.collected_at)}` : ""}</small></td><td>{offer.mall}</td><td>{money(offer.price)}</td><td>{money(offer.shipping)}</td><td><strong>{money(offer.total)}</strong></td><td><label className="seller-monitor-check"><input type="checkbox" checked={monitored.has(offerIdentity(offer))} disabled={disabled || !safeOfferUrl(offer.url) || offer.price <= 0} aria-label={`${sellerSourceLabels[source]} ${offer.mall} ${offer.name} 모니터링`} onChange={(event) => onToggle(offer, event.target.checked)} /><span>{monitored.has(offerIdentity(offer)) ? "ON" : "선택"}</span></label></td>
    </tr>)}</tbody></table></div>}
    {rows.length > 10 && <button className="seller-more" onClick={() => setExpanded((open) => !open)}>{expanded ? "10개로 접기" : `감지된 ${rows.length}개 모두 검토하기`}</button>}
  </section>;
}
