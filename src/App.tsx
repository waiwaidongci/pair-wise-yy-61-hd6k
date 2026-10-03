import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { BrowserRouter, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Divider,
  Field,
  FluentProvider,
  Input,
  MessageBar,
  MessageBarBody,
  ProgressBar,
  Tab,
  TabList,
  Tag,
  Text,
  Textarea,
  Tooltip,
  webLightTheme
} from '@fluentui/react-components';
import {
  AlertRegular,
  ArrowDownloadRegular,
  ArrowSyncRegular,
  BookOpenRegular,
  BranchRegular,
  CheckmarkCircleRegular,
  ClipboardTaskListLtrRegular,
  CloudArrowUpRegular,
  CloudOffRegular,
  DocumentBulletListRegular,
  GaugeRegular,
  HistoryRegular,
  LockClosedRegular,
  NavigationRegular,
  PeopleRegular,
  WarningRegular
} from '@fluentui/react-icons';
import {
  useExternalRelationChangeMutation,
  useGetWorkPackageQuery,
  useSubmitCardMutation,
  useUpdateRelationsMutation,
  type RelationChangePayload
} from './api';
import { findDependencyCycle } from './graph';
import {
  ackLegacyUpgrade,
  appendAudit,
  applyRelationChange,
  authorizeOverride,
  confirmRelationChange,
  discardRelationDraft,
  recalcCard,
  refreshVersion,
  releasePackage,
  rollbackRelationChange,
  saveRelationDraft,
  selectCard,
  setConflict,
  signStage,
  toggleOffline,
  updateCard,
  type RelationDraft,
  type RootState
} from './store';

type NavItem = { path: string; label: string; icon: ReactNode };

type RelationError = {
  status?: number;
  data?: { message?: string; currentVersion?: number; winningChange?: RelationChangePayload | null };
};

function Shell({ children }: { children: ReactNode }) {
  const state = useSelector((root: RootState) => root.maintenance);
  const dispatch = useDispatch();
  const pendingCount = state.cards.filter((card) => card.status === '待授权').length;
  const invalidCount = state.cards.filter((card) => card.status === '已失效').length;
  const nav: NavItem[] = [
    { path: '/', label: '工作包总览', icon: <ClipboardTaskListLtrRegular /> },
    { path: '/execution', label: '工卡执行', icon: <BookOpenRegular /> },
    { path: '/release', label: '放行审阅', icon: <LockClosedRegular /> },
    { path: '/audit', label: '审计与差异', icon: <HistoryRegular /> }
  ];
  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand">
          <div className="brand-icon"><NavigationRegular /></div>
          <div><strong>航空定检执行台</strong><span>Maintenance Work Package</span></div>
        </div>
        <div className="aircraft-chip"><span>B-7891</span><strong>B737-800</strong><Badge appearance="tint" color="brand">48A 定检</Badge></div>
        <div className="header-spacer" />
        <button className={`sync-status ${state.offline ? 'offline' : ''}`} onClick={() => dispatch(toggleOffline())}>
          {state.offline ? <CloudOffRegular /> : <CloudArrowUpRegular />}<span>{state.offline ? '离线暂存' : `已同步 R${state.syncVersion} · 关系 V${state.relationVersion}`}</span>
        </button>
        <div className="user-chip"><span>执行人员</span><strong>宋杰 · 机械</strong></div>
      </header>
      <div className="shell-grid">
        <aside className="side-nav">
          <div className="package-summary">
            <span>工作包</span><strong>WP-B7891-04</strong><small>上海浦东 · H3 机库</small>
            <div><ProgressBar value={0.58} /><span>58% 工卡完成</span></div>
          </div>
          <nav>{nav.map((item) => <NavLink end={item.path === '/'} key={item.path} to={item.path}>{item.icon}<span>{item.label}</span></NavLink>)}</nav>
          <div className="side-status"><WarningRegular /><div><strong>{pendingCount} 项待授权{invalidCount > 0 ? ` · ${invalidCount} 项已失效` : ''}</strong><span>放行前必须处理</span></div></div>
        </aside>
        <main>{children}</main>
      </div>
    </div>
  );
}

function PageHeading({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return <div className="page-heading"><div><small>{eyebrow}</small><h1>{title}</h1><p>{description}</p></div><div className="heading-actions">{actions}</div></div>;
}

/** 依赖关系编辑器：成环拒绝、乐观写入、失败回滚、冲突草稿。 */
function RelationEditor({ open, cardId, onClose }: { open: boolean; cardId: string; onClose: () => void }) {
  const state = useSelector((root: RootState) => root.maintenance);
  const dispatch = useDispatch();
  const [selectedCardId, setSelectedCardId] = useState(cardId);
  const [deps, setDeps] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [simulateFailure, setSimulateFailure] = useState(false);
  const [updateRelations] = useUpdateRelationsMutation();
  const [externalChange] = useExternalRelationChangeMutation();

  useEffect(() => {
    if (open) {
      setSelectedCardId(cardId);
      setError('');
      setNotice('');
    }
  }, [open, cardId]);

  useEffect(() => {
    if (!open) return;
    const card = state.cards.find((item) => item.id === selectedCardId);
    if (card) setDeps(card.dependencies);
    // 仅在切换工卡或打开对话框时重置选择，编辑过程中不回填
  }, [selectedCardId, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggleDep = (id: string, checked: boolean) => {
    setDeps((prev) => (checked ? [...prev, id] : prev.filter((dep) => dep !== id)));
  };

  const submit = async (targetCardId: string, nextDeps: string[], draftId?: string) => {
    setError('');
    setNotice('');
    const preview = state.cards.map((item) => (item.id === targetCardId ? { ...item, dependencies: nextDeps } : item));
    const cycle = findDependencyCycle(preview);
    if (cycle) {
      setError(`新关系成环，已拒绝：${cycle.join(' → ')}`);
      dispatch(appendAudit({ action: '依赖成环拒绝', detail: `${targetCardId} 调整被拒绝，回路：${cycle.join(' → ')}`, actor: '宋杰（工艺）' }));
      return;
    }
    const snapshot = { cards: state.cards, signatures: state.signatures, relationVersion: state.relationVersion, relationLog: state.relationLog };
    setBusy(true);
    dispatch(applyRelationChange({ cardId: targetCardId, nextDeps, newVersion: state.relationVersion + 1, actor: '宋杰（工艺）' }));
    try {
      const result = await updateRelations({ cardId: targetCardId, dependencies: nextDeps, expectedRelationVersion: snapshot.relationVersion, actor: '宋杰（工艺）', simulateFailure }).unwrap();
      dispatch(confirmRelationChange({ newVersion: result.relationVersion }));
      if (draftId) dispatch(discardRelationDraft(draftId));
      setNotice(`已生效：关系版本升至 V${result.relationVersion}，下游工卡已失效重算，受影响阶段签字已退回。`);
    } catch (rawError) {
      const err = rawError as RelationError;
      dispatch(rollbackRelationChange(snapshot));
      if (draftId) dispatch(discardRelationDraft(draftId));
      if (err.status === 409) {
        const winning = err.data?.winningChange;
        if (winning) {
          dispatch(applyRelationChange({ cardId: winning.cardId, nextDeps: winning.dependencies, newVersion: winning.version, actor: winning.actor }));
        }
        dispatch(saveRelationDraft({ cardId: targetCardId, nextDeps, baseVersion: snapshot.relationVersion, serverVersion: err.data?.currentVersion ?? snapshot.relationVersion, reason: '版本冲突' }));
        setError(err.data?.message ?? '版本冲突：先到者已生效，本次提交已留存为冲突草稿。');
      } else if (err.status === 422) {
        setError(err.data?.message ?? '新关系成环，已拒绝。');
      } else {
        dispatch(saveRelationDraft({ cardId: targetCardId, nextDeps, baseVersion: snapshot.relationVersion, serverVersion: snapshot.relationVersion, reason: '写入失败' }));
        setError(`${err.data?.message ?? '写入失败'} 已按原请求恢复，草稿已保留可重试。`);
      }
    } finally {
      setBusy(false);
    }
  };

  const simulateConcurrent = async () => {
    setError('');
    setNotice('');
    const result = await externalChange({ cardId: selectedCardId, dependencies: deps, actor: '王工（工艺）' }).unwrap().catch(() => null);
    if (result) {
      setNotice(`另一工艺员（王工）已抢先提交同一关系，服务器关系版本升至 V${result.relationVersion}。现在点击「提交调整」将触发先到者生效、本机留存冲突草稿。`);
    }
  };

  const retryDraft = (draft: RelationDraft) => {
    setSelectedCardId(draft.cardId);
    setDeps(draft.nextDeps);
    void submit(draft.cardId, draft.nextDeps, draft.id);
  };

  const selectedCard = state.cards.find((item) => item.id === selectedCardId);
  return (
    <Dialog open={open} onOpenChange={(_, data) => { if (!data.open) onClose(); }}>
      <DialogSurface className="relation-dialog">
        <DialogBody>
          <DialogTitle>调整工卡依赖 <Badge appearance="tint" color="brand">关系版本 V{state.relationVersion}</Badge></DialogTitle>
          <DialogContent>
            <p className="dialog-intro">工卡依赖、执行状态与放行门禁共用同一份版本关系。提交生效后下游工卡自动失效重算（现场测量与证据原值保留），受影响阶段签字退回处理。</p>
            <Field label="选择工卡" className="dialog-field">
              <select value={selectedCardId} onChange={(event) => setSelectedCardId(event.target.value)} disabled={busy}>
                {state.cards.map((card) => <option key={card.id} value={card.id}>{card.id} · {card.title}</option>)}
              </select>
            </Field>
            <div className="dep-checklist">
              {state.cards.filter((card) => card.id !== selectedCardId).map((card) => (
                <label key={card.id}>
                  <Checkbox checked={deps.includes(card.id)} disabled={busy} onChange={(_, data) => toggleDep(card.id, Boolean(data.checked))} />
                  <span>{card.id} · {card.title}</span>
                  <small>{card.status}</small>
                </label>
              ))}
            </div>
            {selectedCard && <p className="dialog-intro">当前前置：{selectedCard.dependencies.join('、') || '无'} → 调整后：{deps.join('、') || '无'}</p>}
            {error && <MessageBar intent="error" className="dialog-message"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
            {notice && <MessageBar intent="info" className="dialog-message"><MessageBarBody>{notice}</MessageBarBody></MessageBar>}
            <label className="simulate-row"><Checkbox checked={simulateFailure} onChange={(_, data) => setSimulateFailure(Boolean(data.checked))} /><span>模拟写入失败（验证按原请求回滚恢复）</span></label>
            {state.relationDrafts.length > 0 && (
              <div className="draft-list">
                <h4>未生效草稿（{state.relationDrafts.length}）</h4>
                {state.relationDrafts.map((draft) => (
                  <div className="draft-row" key={draft.id}>
                    <div>
                      <strong>{draft.cardId} → {draft.nextDeps.join('、') || '无前置'}</strong>
                      <small>{draft.reason} · 基于 V{draft.baseVersion} · 服务器 V{draft.serverVersion} · {draft.time}</small>
                    </div>
                    <Button size="small" appearance="primary" disabled={busy} onClick={() => retryDraft(draft)}>按当前版本重提</Button>
                    <Button size="small" appearance="subtle" disabled={busy} onClick={() => dispatch(discardRelationDraft(draft.id))}>放弃</Button>
                  </div>
                ))}
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" disabled={busy} onClick={simulateConcurrent}>模拟另一工艺员提交同一关系</Button>
            <Button appearance="secondary" disabled={busy} onClick={onClose}>关闭</Button>
            <Button appearance="primary" disabled={busy} onClick={() => void submit(selectedCardId, deps)}>{busy ? '提交中…' : '提交调整'}</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

function Overview() {
  const state = useSelector((root: RootState) => root.maintenance);
  const { data } = useGetWorkPackageQuery();
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const [relationOpen, setRelationOpen] = useState(false);
  const completed = state.cards.filter((card) => card.status === '已完成').length;
  const blockers = state.cards.filter((card) => card.status === '待授权' || card.status === '已失效');
  const invalidated = state.cards.filter((card) => card.status === '已失效');
  return (
    <div className="page">
      <PageHeading eyebrow="WP-B7891-04 / 48A CHECK" title="工作包总览" description="监控工卡依赖、阶段签署、超差项目和放行门禁。" actions={<><Button appearance="secondary" icon={<ArrowDownloadRegular />}>导出进度</Button><Button appearance="primary" icon={<NavigationRegular />} onClick={() => navigate('/execution')}>继续执行</Button></>} />
      {state.legacyUpgraded && <MessageBar intent="success" className="top-message"><MessageBarBody><strong>兼容升级完成：</strong>旧工作包缺少关系版本，已按服务器关系版本 V{state.relationVersion} 升级，工卡依赖、执行状态与放行门禁已对齐到同一份版本关系。</MessageBarBody><Button appearance="secondary" size="small" onClick={() => dispatch(ackLegacyUpgrade())}>知道了</Button></MessageBar>}
      {state.relationDrafts.length > 0 && <MessageBar intent="warning" className="top-message"><MessageBarBody><strong>依赖草稿未生效：</strong>{state.relationDrafts.length} 份依赖修改因{state.relationDrafts[0].reason}未生效，原请求已保留。</MessageBarBody><Button appearance="secondary" size="small" onClick={() => setRelationOpen(true)}>处理草稿</Button></MessageBar>}
      {invalidated.length > 0 && <MessageBar intent="error" className="top-message"><MessageBarBody><strong>失效重算：</strong>{invalidated.map((card) => card.id).join('、')} 因依赖关系变更已失效，现场测量与证据原值保留，放行门禁已阻断。</MessageBarBody></MessageBar>}
      {blockers.length > 0 && <MessageBar intent="warning" className="top-message"><MessageBarBody><strong>放行阻断：</strong>{blockers.map((card) => `${card.id} ${card.title}`).join('、')} 需处理（待授权 / 失效重算）。</MessageBarBody></MessageBar>}
      <div className="metrics-grid">
        {[
          ['工卡完成度', `${completed} / ${state.cards.length}`, `${Math.round(completed / state.cards.length * 100)}%`, 'green'],
          ['已记录工时', '18.6 h', '计划 20.5 h', 'blue'],
          ['失效待重算', String(invalidated.length), invalidated.length > 0 ? '原测量值已保留' : `关系版本 V${state.relationVersion} 一致`, 'amber'],
          ['待签署阶段', String(state.signatures.filter((item) => item.status === '待签署').length), '放行前完成', 'red']
        ].map((item) => <div className="metric-card" key={item[0]}><span>{item[0]}</span><strong>{item[1]}</strong><small className={item[3]}>{item[2]}</small></div>)}
      </div>
      <div className="overview-grid">
        <section className="panel task-panel">
          <div className="panel-head"><div><h2>关键工卡与依赖</h2><span>按执行依赖和风险排序</span></div><Badge appearance="tint">{data?.revision ?? 'WP R7'}</Badge></div>
          {state.cards.map((card, index) => (
            <button key={card.id} className={`task-row ${state.activeCardId === card.id ? 'active' : ''}`} onClick={() => { dispatch(selectCard(card.id)); navigate('/execution'); }}>
              <span className={`task-index ${card.status === '已完成' ? 'done' : card.status === '待授权' || card.status === '已失效' ? 'blocked' : ''}`}>{card.status === '已完成' ? <CheckmarkCircleRegular /> : index + 1}</span>
              <span className="task-main"><strong>{card.id} · {card.title}</strong><small>{card.zone} · 依赖 {card.dependencies.length ? card.dependencies.join('、') : '无'} · 计划 {card.estimated}h{card.status === '已失效' ? ' · 已失效待重算' : ''}</small></span>
              <Tag appearance="outline" size="small">{card.stage}</Tag>
              <Badge appearance="tint" color={card.status === '已完成' ? 'success' : card.status === '待授权' || card.status === '已失效' ? 'danger' : card.status === '执行中' ? 'brand' : 'informative'}>{card.status}</Badge>
            </button>
          ))}
        </section>
        <aside className="overview-side">
          <section className="panel stage-panel"><div className="panel-head"><h2>阶段签字</h2><PeopleRegular /></div>{state.signatures.map((item) => <div className="signature-row" key={item.stage}><span className={item.status === '已签署' ? 'signed' : ''}>{item.status === '已签署' ? <CheckmarkCircleRegular /> : item.stage.slice(0, 1)}</span><div><strong>{item.stage}签署</strong><small>{item.actor} · {item.time}</small></div></div>)}</section>
          <section className="panel dependency-panel">
            <div className="panel-head"><div><h2>依赖关系</h2><span>关系版本 V{state.relationVersion} · 状态与门禁共用</span></div><GaugeRegular /></div>
            <div className="dependency-edges">
              {state.cards.filter((card) => card.dependencies.length > 0).map((card) => (
                <div className="edge-row" key={card.id}><span>{card.dependencies.join('、')}</span><i>→</i><strong>{card.id}</strong>{card.status === '已失效' && <Badge appearance="tint" color="danger" size="small">已失效</Badge>}</div>
              ))}
            </div>
            {invalidated.length > 0 && <div className="edge-invalid">{invalidated.map((card) => card.id).join('、')} 失效待重算，放行门禁已阻断</div>}
            <div className="panel-actions"><Button appearance="secondary" size="small" icon={<BranchRegular />} onClick={() => setRelationOpen(true)}>调整依赖</Button></div>
          </section>
        </aside>
      </div>
      <RelationEditor open={relationOpen} cardId={state.activeCardId} onClose={() => setRelationOpen(false)} />
    </div>
  );
}

function Execution() {
  const state = useSelector((root: RootState) => root.maintenance);
  const dispatch = useDispatch();
  const { data } = useGetWorkPackageQuery();
  const card = state.cards.find((item) => item.id === state.activeCardId) ?? state.cards[0];
  const [measurement, setMeasurement] = useState(card.measurement);
  const [finding, setFinding] = useState(card.finding);
  const [consumable, setConsumable] = useState('');
  const [witness, setWitness] = useState(false);
  const [overrideOpen, setOverrideOpen] = useState(false);
  const [relationOpen, setRelationOpen] = useState(false);
  const [submitCard] = useSubmitCardMutation();
  useEffect(() => { setMeasurement(card.measurement); setFinding(card.finding); }, [card.id, card.measurement, card.finding]);
  const toleranceIssue = card.id === 'CARD-03' && Number.parseFloat(measurement) < 2850;
  const unmetDeps = card.dependencies.filter((dependency) => state.cards.find((item) => item.id === dependency)?.status !== '已完成');
  const complete = async () => {
    if (card.status === '已失效') {
      dispatch(setConflict('本工卡已失效，请先在右侧按新关系重算恢复。'));
      return;
    }
    if (unmetDeps.length > 0) {
      dispatch(setConflict(`前置工卡 ${unmetDeps.join('、')} 未完成或已失效。`));
      return;
    }
    if (toleranceIssue) {
      dispatch(setConflict('测量值超出容差，必须由授权人员处理。'));
      return;
    }
    if (!witness) {
      dispatch(setConflict('关键步骤必须完成见证确认。'));
      return;
    }
    if (state.syncVersion !== state.serverVersion) {
      dispatch(setConflict('检测到冲突提交：本地版本与服务器版本不一致，请刷新后重试。'));
      return;
    }
    const result = await submitCard({ cardId: card.id, expectedRevision: state.serverVersion, measurement, finding }).unwrap().catch((error) => {
      dispatch(setConflict(error.data?.message ?? '提交失败，请重试。'));
      return null;
    });
    if (result?.accepted) {
      dispatch(updateCard({ measurement, finding, status: '已完成' }));
      dispatch(setConflict(''));
    }
  };
  return (
    <div className="page">
      <PageHeading eyebrow={`${card.id} / ${card.stage}`} title={card.title} description={`${card.zone} · 工卡版本 ${data?.revision ?? 'R7'} · 关系版本 V${state.relationVersion} · 预计 ${card.estimated} 小时`} actions={<><Button appearance="secondary" icon={<BranchRegular />} onClick={() => setRelationOpen(true)}>调整依赖</Button><Button appearance="secondary" icon={<ArrowSyncRegular />} onClick={() => dispatch(toggleOffline())}>{state.offline ? '恢复在线' : '离线暂存'}</Button><Button appearance="primary" icon={<CheckmarkCircleRegular />} onClick={complete}>完成并提交</Button></>} />
      {state.conflictMessage && <MessageBar intent="error" className="top-message"><MessageBarBody><strong>提交被阻断：</strong>{state.conflictMessage}</MessageBarBody><Button appearance="secondary" size="small" onClick={() => dispatch(refreshVersion())}>刷新版本</Button></MessageBar>}
      {state.relationDrafts.length > 0 && <MessageBar intent="warning" className="top-message"><MessageBarBody><strong>依赖草稿：</strong>{state.relationDrafts.length} 份依赖修改未生效（{state.relationDrafts[0].reason}），原请求已保留。</MessageBarBody><Button appearance="secondary" size="small" onClick={() => setRelationOpen(true)}>查看草稿</Button></MessageBar>}
      <div className="execution-grid">
        <section className="panel card-editor">
          <div className="panel-head"><div><h2>工卡执行内容</h2><span>执行人员必须记录关键数据及证据</span></div><Badge appearance="tint" color={card.status === '待授权' || card.status === '已失效' ? 'danger' : 'brand'}>{card.status}</Badge></div>
          <div className="procedure-block">
            <h3>施工步骤</h3>
            {['确认飞机断电并设置 DO NOT OPERATE 警告牌。', '连接校准合格的测试设备，按 AMM 29-10-00 执行压力保持测试。', '记录稳定压力值，检查 10 分钟内压降。', '恢复系统构型，目视检查渗漏并上传证据。'].map((step, index) => <label key={step} className="procedure-step"><Checkbox defaultChecked={index < 2} /><span><b>{index + 1}.</b> {step}</span></label>)}
          </div>
          <Divider />
          <div className="form-grid">
            <Field label="测量值" hint={card.tolerance} validationState={toleranceIssue ? 'error' : 'none'} validationMessage={toleranceIssue ? '低于最低接受值 2850 psi' : undefined}><Input value={measurement} onChange={(_, data) => setMeasurement(data.value)} contentBefore={<GaugeRegular />} /></Field>
            <Field label="耗材 / 航材"><Input value={consumable} onChange={(_, data) => setConsumable(data.value)} placeholder="输入件号或耗材批次" /></Field>
            <Field label="发现与处置" className="wide-field"><Textarea value={finding} onChange={(_, data) => setFinding(data.value)} resize="vertical" placeholder="正常或填写缺陷、处置措施" /></Field>
            <Field label="证据附件" className="wide-field"><div className="upload-zone"><CloudArrowUpRegular /><strong>拖入照片、测试记录或报告</strong><span>已关联 3 个证据 · 支持 JPG / PDF / TXT</span></div></Field>
          </div>
          <label className="witness-check"><Checkbox checked={witness} onChange={(_, data) => setWitness(Boolean(data.checked))} /><span><strong>见证人已现场确认</strong><small>要求：{card.witness}</small></span></label>
        </section>
        <aside className="execution-side">
          <section className="panel card-meta">
            <div className="panel-head"><h2>工卡信息</h2><DocumentBulletListRegular /></div>
            <dl>
              <div><dt>容差</dt><dd>{card.tolerance}</dd></div>
              <div><dt>证据要求</dt><dd>{card.evidence}</dd></div>
              <div><dt>前置条件</dt><dd>{card.dependencies.length ? card.dependencies.join('、') : '无'}</dd></div>
              <div><dt>阶段签署</dt><dd>{card.stage}</dd></div>
              <div><dt>关系版本</dt><dd>V{state.relationVersion}（依赖 · 状态 · 放行门禁共用）</dd></div>
            </dl>
            <div className="card-meta-actions"><Button appearance="secondary" size="small" icon={<BranchRegular />} onClick={() => setRelationOpen(true)}>调整依赖</Button></div>
          </section>
          {card.status === '已失效' && (
            <section className="panel invalidated-panel">
              <WarningRegular />
              <h3>工卡已失效，等待重算</h3>
              <p><strong>失效原因：</strong>{card.invalidReason}</p>
              <p><strong>重算结果：</strong>{card.recalcResult}</p>
              <p>原测量值 {card.measurement || '—'}、发现记录与证据附件均已保留。</p>
              <Button appearance="primary" onClick={() => dispatch(recalcCard(card.id))}>按 V{state.relationVersion} 重算并恢复执行</Button>
            </section>
          )}
          {card.status === '待授权' && <section className="panel override-panel"><WarningRegular /><h3>超差项目等待授权</h3><p>原始测量值已保留。授权人员可以批准工程指令、退回复测或要求停场处理。</p><Button appearance="primary" onClick={() => setOverrideOpen(true)}>授权处理</Button></section>}
          <section className="panel evidence-panel"><div className="panel-head"><h2>证据附件</h2><Badge appearance="tint">3 项</Badge></div>{['IMG_20260929_0904.jpg', '液压测试原始记录.pdf', '见证签字单_宋杰.pdf'].map((file, index) => <div className="evidence-row" key={file}><DocumentBulletListRegular /><div><strong>{file}</strong><small>{index + 1}.8 MB · 09:1{index}</small></div><Button size="small" appearance="subtle">预览</Button></div>)}</section>
        </aside>
      </div>
      <Dialog open={overrideOpen} onOpenChange={(_, data) => setOverrideOpen(data.open)}><DialogSurface><DialogBody><DialogTitle>超差授权处理</DialogTitle><DialogContent>批准后将在工卡中记录授权人、工程指令编号与处置依据，原始测量值不会被覆盖。<Field label="工程指令编号" required className="dialog-field"><Input defaultValue="EO-2026-1147" /></Field><Field label="授权依据" required className="dialog-field"><Textarea defaultValue="按 AMM 容差分析并经工程部门确认，允许执行复测与系统恢复。" /></Field></DialogContent><DialogActions><Button appearance="secondary" onClick={() => setOverrideOpen(false)}>取消</Button><Button appearance="primary" onClick={() => { dispatch(authorizeOverride()); setOverrideOpen(false); }}>确认授权</Button></DialogActions></DialogBody></DialogSurface></Dialog>
      <RelationEditor open={relationOpen} cardId={card.id} onClose={() => setRelationOpen(false)} />
    </div>
  );
}

function Release() {
  const state = useSelector((root: RootState) => root.maintenance);
  const dispatch = useDispatch();
  const [tab, setTab] = useState('open');
  const blockers = state.cards.filter((card) => card.status !== '已完成' && card.status !== '未开始');
  const invalidated = state.cards.filter((card) => card.status === '已失效');
  const allSigned = state.signatures.every((item) => item.status === '已签署');
  const gatesClear = !blockers.some((card) => card.status === '待授权') && invalidated.length === 0 && state.relationDrafts.length === 0;
  return (
    <div className="page">
      <PageHeading eyebrow="RELEASE REVIEW / B-7891" title="放行审阅" description={`核对未关闭项目、失效重算、关键证据与阶段签字 · 关系版本 V${state.relationVersion}`} actions={<Button appearance="primary" icon={<LockClosedRegular />} disabled={!allSigned || !gatesClear} onClick={() => dispatch(releasePackage())}>{state.released ? '工作包已锁定' : '锁定并放行'}</Button>} />
      {state.released && <MessageBar intent="success" className="top-message"><MessageBarBody>工作包已锁定，形成只读放行基线并纳入审计记录。</MessageBarBody></MessageBar>}
      {invalidated.length > 0 && <MessageBar intent="error" className="top-message"><MessageBarBody><strong>放行被阻断：</strong>{invalidated.map((card) => card.id).join('、')} 因依赖关系变更已失效，需重算恢复后方可放行。</MessageBarBody></MessageBar>}
      <div className="release-grid">
        <section className="panel release-main">
          <TabList selectedValue={tab} onTabSelect={(_, data) => setTab(String(data.value))}><Tab value="open">未关闭项目 <Badge>{blockers.length}</Badge></Tab><Tab value="invalid">失效重算 <Badge>{invalidated.length}</Badge></Tab><Tab value="repeat">重复缺陷 <Badge>2</Badge></Tab><Tab value="evidence">关键证据 <Badge>12</Badge></Tab></TabList>
          <div className="tab-body">
            {tab === 'open' && blockers.map((card) => (
              <div className="review-item" key={card.id}>
                <span className={`risk-icon ${card.status === '待授权' || card.status === '已失效' ? 'danger' : ''}`}><AlertRegular /></span>
                <div>
                  <strong>{card.id} · {card.title}</strong>
                  {card.status === '已失效' ? (
                    <>
                      <p><strong>失效原因：</strong>{card.invalidReason}</p>
                      <p><strong>重算结果：</strong>{card.recalcResult}</p>
                      <small>原测量值 {card.measurement || '—'} 与证据已保留 · {card.zone} · {card.stage}</small>
                    </>
                  ) : (
                    <>
                      <p>{card.finding || '工卡正在执行，完成后需由放行人员复核。'}</p>
                      <small>{card.zone} · 负责人 宋杰 · 要求证据 {card.evidence}</small>
                    </>
                  )}
                </div>
                <Badge appearance="tint" color={card.status === '待授权' || card.status === '已失效' ? 'danger' : 'warning'}>{card.status === '已失效' ? '阻断 · 已失效' : card.status}</Badge>
              </div>
            ))}
            {tab === 'invalid' && (invalidated.length === 0 ? (
              <div className="review-item"><span className="risk-icon ok"><CheckmarkCircleRegular /></span><div><strong>无失效工卡</strong><p>当前关系版本 V{state.relationVersion} 下所有工卡状态有效，依赖、执行状态与放行门禁一致。</p></div><Badge appearance="tint" color="success">一致</Badge></div>
            ) : invalidated.map((card) => (
              <div className="review-item" key={card.id}>
                <span className="risk-icon danger"><WarningRegular /></span>
                <div>
                  <strong>{card.id} · {card.title}</strong>
                  <p><strong>失效原因：</strong>{card.invalidReason}</p>
                  <p><strong>重算结果：</strong>{card.recalcResult}</p>
                  <small>原测量值 {card.measurement || '—'} 与证据原值保留 · 需在工卡执行页重算恢复</small>
                </div>
                <Badge appearance="tint" color="danger">阻断放行</Badge>
              </div>
            )))}
            {tab === 'repeat' && <><div className="review-item"><span className="risk-icon danger"><HistoryRegular /></span><div><strong>液压系统压力偏低 · 第 3 次记录</strong><p>2026-08-16、09-02、09-29 均在系统 A 出现压力低于目标值。</p><small>建议移交可靠性分析，并关联历史排故记录。</small></div><Badge appearance="tint" color="danger">关键</Badge></div><div className="review-item"><span className="risk-icon"><HistoryRegular /></span><div><strong>APU 启动时间延长</strong><p>最近两次航线记录均略高于机队均值。</p><small>非放行阻塞项，建议后续监控。</small></div><Badge appearance="tint" color="warning">观察</Badge></div></>}
            {tab === 'evidence' && <div className="evidence-grid">{['液压系统测试记录.pdf', '发动机孔探照片_01.jpg', 'AD 执行签署页.pdf', '时寿件履历截图.png', '超差工程指令.pdf', '见证人签字单.pdf'].map((file) => <div className="evidence-tile" key={file}><DocumentBulletListRegular /><strong>{file}</strong><span>已绑定工卡 · 已核验</span></div>)}</div>}
          </div>
        </section>
        <aside className="release-side">
          <section className="panel signoff-card"><div className="panel-head"><h2>分阶段签字</h2><span>{state.signatures.filter((item) => item.status === '已签署').length} / 4</span></div>{state.signatures.map((item) => <div className="signoff-row" key={item.stage}><div><span>{item.stage}</span><strong>{item.actor}</strong><small>{item.time}</small></div>{item.status === '已签署' ? <Badge appearance="tint" color="success">已签署</Badge> : <Button size="small" appearance="primary" onClick={() => dispatch(signStage(item.stage))}>签署</Button>}</div>)}</section>
          <section className="panel release-gate-card">
            <LockClosedRegular />
            <h3>放行门禁 · 关系版本 V{state.relationVersion}</h3>
            <label><Checkbox checked={!blockers.some((card) => card.status === '待授权')} readOnly /> 无待授权超差项目</label>
            <label><Checkbox checked={invalidated.length === 0} readOnly /> 无失效待重算工卡</label>
            <label><Checkbox checked={state.cards.filter((card) => card.status === '已完成').length >= 6} readOnly /> 关键工卡完成率 ≥ 75%</label>
            <label><Checkbox checked={allSigned} readOnly /> 四个阶段均完成电子签署</label>
            <label><Checkbox checked={state.relationDrafts.length === 0} readOnly /> 无未处理的依赖冲突草稿</label>
            <label><Checkbox checked /> 审计记录和证据附件完整</label>
          </section>
        </aside>
      </div>
    </div>
  );
}

function Audit() {
  const state = useSelector((root: RootState) => root.maintenance);
  const [selected, setSelected] = useState('R7');
  const downloadAudit = () => {
    const csv = ['时间,操作者,动作,说明', ...state.audit.map((item) => [item.time, item.actor, item.action, item.detail].join(','))].join('\n');
    const url = URL.createObjectURL(new Blob([`\ufeff${csv}`], { type: 'text/csv;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'B7891-48A-audit.csv';
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const diffs = useMemo(() => [
    { card: 'CARD-03', field: '容差', from: '≥ 2800 psi / 10 min', to: '≥ 2850 psi / 10 min', reason: 'AMM 临时修订 TR-114' },
    { card: 'CARD-07', field: '依赖', from: 'CARD-02', to: 'CARD-03', reason: '试车前置条件调整' },
    { card: 'CARD-08', field: '证据', from: '近 2 次记录', to: '近 3 次记录', reason: '可靠性复核要求' }
  ], []);
  return (
    <div className="page">
      <PageHeading eyebrow="AUDIT / VERSION CONTROL" title="审计与版本差异" description="对比工卡版本、查看操作历史并导出闭环证据。" actions={<Button appearance="primary" icon={<ArrowDownloadRegular />} onClick={downloadAudit}>导出审计记录</Button>} />
      <div className="audit-grid">
        <section className="panel diff-panel"><div className="panel-head"><div><h2>工卡版本差异</h2><span>R6 → R7 · 3 处变更</span></div><select value={selected} onChange={(event) => setSelected(event.target.value)}><option>R7</option><option>R6</option><option>R5</option></select></div><div className="diff-table"><div className="diff-head"><span>工卡</span><span>字段</span><span>原值</span><span>新值 / 原因</span></div>{diffs.map((diff) => <div className="diff-row" key={`${diff.card}-${diff.field}`}><strong>{diff.card}</strong><span>{diff.field}</span><del>{diff.from}</del><div><ins>{diff.to}</ins><small>{diff.reason}</small></div></div>)}</div></section>
        <section className="panel audit-panel"><div className="panel-head"><div><h2>完整审计时间线</h2><span>{state.audit.length} 条记录</span></div><HistoryRegular /></div>{state.audit.map((item, index) => <div className="audit-row" key={`${item.time}-${index}`}><span className="timeline-dot" /><div><strong>{item.action}</strong><p>{item.detail}</p><small>{item.time} · {item.actor}</small></div></div>)}</section>
      </div>
      <section className="panel relation-log-panel">
        <div className="panel-head"><div><h2>关系版本记录</h2><span>工卡依赖、执行状态与放行门禁共用同一份版本关系</span></div><Badge appearance="tint" color="brand">当前 V{state.relationVersion}</Badge></div>
        {state.relationLog.length === 0 && <div className="relation-empty">暂无关系变更，当前为基线版本。</div>}
        {state.relationLog.map((log) => (
          <div className="relation-row" key={`${log.version}-${log.time}-${log.cardId}`}>
            <Badge appearance="tint" color="brand">V{log.version}</Badge>
            <div>
              <strong>{log.cardId} 前置 {log.from.join('、') || '无'} → {log.to.join('、') || '无'}</strong>
              <small>{log.actor} · {log.time}{log.invalidated.length > 0 ? ` · 失效重算：${log.invalidated.join('、')}` : ''}{log.returnedStages.length > 0 ? ` · 签字退回：${log.returnedStages.join('、')}` : ''}</small>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function NotFound() {
  return <Navigate to="/" replace />;
}

export default function App() {
  return (
    <FluentProvider theme={webLightTheme}>
      <BrowserRouter>
        <Shell><Routes><Route path="/" element={<Overview />} /><Route path="/execution" element={<Execution />} /><Route path="/release" element={<Release />} /><Route path="/audit" element={<Audit />} /><Route path="*" element={<NotFound />} /></Routes></Shell>
      </BrowserRouter>
    </FluentProvider>
  );
}
