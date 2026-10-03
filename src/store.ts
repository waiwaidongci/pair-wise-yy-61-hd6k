import { configureStore, createAsyncThunk, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { maintenanceApi } from './api';

// ---------- Types ----------
export type CardStatus = '未开始' | '执行中' | '待授权' | '已完成' | '已失效';

export type StageSignature = { stage: string; status: '待签署' | '已签署'; actor: string; time: string };

export type OfflineCard = {
  id: string;
  title: string;
  estimated: number;
  zone: string;
  dependencies: string[];
  tolerance: string;
  evidence: string;
  witness: string;
  status: CardStatus;
  measurement: string;
  finding: string;
  stage: string;
  relationVersion?: number;
  invalidated?: boolean;
  invalidatedReason?: string;
  recalcResult?: string;
  recalcAt?: string;
};

export type RelationDraft = {
  id: string;
  cardId: string;
  title: string;
  dependencies: string[];
  expectedVersion: number;
  submittedAt: string;
  submittedBy: string;
  status: '冲突草稿' | '已采纳' | '已丢弃';
  reason: string;
};

export type AuditEntry = { time: string; actor: string; action: string; detail: string };

type MaintenanceState = {
  cards: OfflineCard[];
  activeCardId: string;
  syncVersion: number;
  serverVersion: number;
  relationVersion: number;
  serverRelationVersion: number;
  offline: boolean;
  lastSaved: string;
  conflictMessage: string;
  signatures: StageSignature[];
  released: boolean;
  audit: AuditEntry[];
  relationDrafts: RelationDraft[];
};

// ---------- Constants ----------
const STAGE_TO_SIGNATURE: Record<string, string> = {
  '机械签署': '机械',
  '发动机签署': '动力',
  '系统签署': '系统',
  '适航签署': '放行',
  '客舱签署': '机械',
  '动力签署': '动力',
  '放行签署': '放行'
};

const now = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

// ---------- Pure helpers ----------
/** Detects a cycle in the dependency graph; returns the loop path (e.g. ['CARD-07','CARD-08','CARD-07']) or null. */
export function findCycle(cards: OfflineCard[], changedId: string, newDeps: string[]): string[] | null {
  const graph = new Map<string, string[]>();
  for (const card of cards) graph.set(card.id, card.id === changedId ? newDeps : card.dependencies);
  const visited = new Set<string>();
  const stack: string[] = [];
  const dfs = (id: string): string[] | null => {
    if (stack.includes(id)) return [...stack.slice(stack.indexOf(id)), id];
    if (visited.has(id)) return null;
    visited.add(id);
    stack.push(id);
    for (const dep of graph.get(id) ?? []) {
      const cycle = dfs(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    return null;
  };
  for (const id of graph.keys()) {
    const cycle = dfs(id);
    if (cycle) return cycle;
  }
  return null;
}

/** Returns all cards that transitively depend on targetId (downstream of a relationship change). */
export function findDownstream(cards: OfflineCard[], targetId: string): string[] {
  const result = new Set<string>();
  const queue = [targetId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const card of cards) {
      if (!result.has(card.id) && card.dependencies.includes(id)) {
        result.add(card.id);
        queue.push(card.id);
      }
    }
  }
  return [...result];
}

/** Returns the unmet prerequisite card ids for a card under the current relationship. */
export function unmetPrerequisites(cards: OfflineCard[], cardId: string): string[] {
  const target = cards.find((c) => c.id === cardId);
  if (!target) return [];
  const unmet: string[] = [];
  for (const dep of target.dependencies) {
    const depCard = cards.find((c) => c.id === dep);
    if (!depCard || depCard.status !== '已完成') unmet.push(dep);
  }
  return unmet;
}

// ---------- Initial data ----------
const initialCards: OfflineCard[] = [
  { id: 'CARD-01', title: '右主起落架收放检查', zone: '起落架舱 RH', estimated: 3.5, dependencies: [], tolerance: '间隙 1.2–2.0 mm', evidence: '近照 + 动作记录', witness: '检验员', status: '已完成', measurement: '1.62 mm', finding: '正常', stage: '机械签署', relationVersion: 1 },
  { id: 'CARD-02', title: '发动机 2 风扇叶片孔探', zone: '发动机 2', estimated: 4.2, dependencies: ['CARD-01'], tolerance: '凹坑 ≤ 0.3 mm', evidence: '孔探照片 + 视频', witness: '发动机工程师', status: '执行中', measurement: '', finding: '', stage: '发动机签署', relationVersion: 1 },
  { id: 'CARD-03', title: '液压系统压力保持测试', zone: '轮舱 / 系统 A', estimated: 2.0, dependencies: ['CARD-01'], tolerance: '≥ 2850 psi / 10 min', evidence: '压力仪记录', witness: '质量检验', status: '待授权', measurement: '2762 psi', finding: '低于容差，等待授权', stage: '系统签署', relationVersion: 1 },
  { id: 'CARD-04', title: '前起落架时寿件核对', zone: '前起落架', estimated: 1.5, dependencies: [], tolerance: '剩余循环 ≥ 500', evidence: '件号照片 + 履历页', witness: '检验员', status: '已完成', measurement: '剩余 836 循环', finding: '正常', stage: '适航签署', relationVersion: 1 },
  { id: 'CARD-05', title: 'AD 2024-15-03 执行确认', zone: '机身后段', estimated: 2.5, dependencies: ['CARD-04'], tolerance: '按 AD 标准施工', evidence: '施工记录 + 签署', witness: '放行人员', status: '未开始', measurement: '', finding: '', stage: '适航签署', relationVersion: 1 },
  { id: 'CARD-06', title: '客舱应急设备检查', zone: '客舱全舱', estimated: 2.8, dependencies: [], tolerance: '全部在有效期内', evidence: '清单复核', witness: '客舱检验', status: '未开始', measurement: '', finding: '', stage: '客舱签署', relationVersion: 1 },
  { id: 'CARD-07', title: 'APU 排故后试车', zone: 'APU 舱', estimated: 3.0, dependencies: ['CARD-03'], tolerance: '参数在 AMM 范围', evidence: '试车数据 + 油样', witness: '动力工程师', status: '未开始', measurement: '', finding: '', stage: '动力签署', relationVersion: 1 },
  { id: 'CARD-08', title: '重复缺陷趋势复核', zone: '全机', estimated: 1.0, dependencies: ['CARD-02', 'CARD-03'], tolerance: '无新增重复缺陷', evidence: '近 3 次记录', witness: '质量经理', status: '执行中', measurement: '发现 2 次压力偏低', finding: '移交可靠性分析', stage: '放行签署', relationVersion: 1 }
];

const defaultState: MaintenanceState = {
  cards: initialCards,
  activeCardId: 'CARD-03',
  syncVersion: 7,
  serverVersion: 7,
  relationVersion: 1,
  serverRelationVersion: 1,
  offline: false,
  lastSaved: '09:46',
  conflictMessage: '',
  signatures: [
    { stage: '机械', status: '已签署', actor: '赵明 · 机械师', time: '09:18' },
    { stage: '系统', status: '待签署', actor: '待指定', time: '-' },
    { stage: '动力', status: '待签署', actor: '待指定', time: '-' },
    { stage: '放行', status: '待签署', actor: '质量经理', time: '-' }
  ],
  released: false,
  audit: [
    { time: '08:54', actor: '赵明', action: '完成工卡', detail: 'CARD-01 间隙测量 1.62 mm' },
    { time: '09:05', actor: '宋杰', action: '提交测量', detail: 'CARD-03 压力 2762 psi，低于容差' },
    { time: '09:20', actor: '系统', action: '阻断', detail: 'CARD-03 等待授权处理' }
  ],
  relationDrafts: []
};

// ---------- Migration ----------
/** Old work packages lack a relationship version; upgrade them compatibly on load. */
function migrate(): MaintenanceState {
  const raw = typeof localStorage !== 'undefined' ? localStorage.getItem('yy61-work-package') : null;
  const saved = raw ? JSON.parse(raw) : null;
  if (saved && typeof saved.relationVersion === 'number') return saved as MaintenanceState;
  const base = (saved ?? defaultState) as MaintenanceState;
  base.relationVersion = 1;
  base.serverRelationVersion = 1;
  base.cards = (base.cards ?? []).map((c: OfflineCard) => ({
    ...c,
    relationVersion: 1,
    invalidated: false,
    invalidatedReason: undefined,
    recalcResult: undefined
  }));
  base.relationDrafts = [];
  base.audit = [
    { time: now(), actor: '系统', action: '关系版本升级', detail: '旧工作包缺少关系版本，已兼容升级至 R1；工卡依赖、执行状态与放行门禁纳入同一份版本关系' },
    ...(base.audit ?? [])
  ];
  return base;
}

// ---------- Snapshot (for rollback) ----------
type Snapshot = {
  cards: OfflineCard[];
  signatures: StageSignature[];
  relationVersion: number;
  syncVersion: number;
  lastSaved: string;
  audit: AuditEntry[];
};

// ---------- Slice ----------
const slice = createSlice({
  name: 'maintenance',
  initialState: migrate(),
  reducers: {
    selectCard(state, action: PayloadAction<string>) {
      state.activeCardId = action.payload;
    },
    updateCard(state, action: PayloadAction<Partial<OfflineCard>>) {
      const card = state.cards.find((item) => item.id === state.activeCardId);
      if (!card || card.invalidated) return;
      Object.assign(card, action.payload);
      state.syncVersion += 1;
      state.lastSaved = now();
      state.audit.unshift({ time: state.lastSaved, actor: '当前用户', action: '离线暂存', detail: `${card.id} 已保存本地草稿` });
    },
    setConflict(state, action: PayloadAction<string>) {
      state.conflictMessage = action.payload;
    },
    refreshVersion(state) {
      state.syncVersion = state.serverVersion;
      state.conflictMessage = '';
    },
    toggleOffline(state) {
      state.offline = !state.offline;
    },
    authorizeOverride(state) {
      const card = state.cards.find((item) => item.id === state.activeCardId);
      if (!card) return;
      card.status = '执行中';
      card.finding = '超差已由授权人员批准，按工程指令继续';
      state.audit.unshift({ time: now(), actor: '放行授权人', action: '授权继续', detail: `${card.id} 超差放行审批` });
    },
    signStage(state, action: PayloadAction<string>) {
      const signature = state.signatures.find((item) => item.stage === action.payload);
      if (!signature) return;
      signature.status = '已签署';
      signature.actor = `${action.payload}负责人`;
      signature.time = now();
      state.audit.unshift({ time: signature.time, actor: signature.actor, action: '阶段签署', detail: `${action.payload}阶段确认完成` });
    },
    releasePackage(state) {
      const hasBlockers = state.cards.some((card) => card.status === '待授权');
      const hasInvalidated = state.cards.some((card) => card.status === '已失效' || card.invalidated);
      const allSigned = state.signatures.every((item) => item.status === '已签署');
      if (!hasBlockers && !hasInvalidated && allSigned) {
        state.released = true;
        state.audit.unshift({ time: now(), actor: '质量经理', action: '锁定放行', detail: `工作包 R${state.relationVersion} 已锁定并形成放行基线` });
      }
    },
    /** Optimistically apply a relationship change: bump version, invalidate affected cards, revert signatures, recalc. */
    applyRelationChange(state, action: PayloadAction<{ cardId: string; dependencies: string[] }>) {
      const { cardId, dependencies } = action.payload;
      const card = state.cards.find((c) => c.id === cardId);
      if (!card) return;
      state.relationVersion += 1;
      const version = state.relationVersion;
      card.dependencies = dependencies;
      card.relationVersion = version;
      // Affected = the changed card plus every card that transitively depends on it.
      const affected = [cardId, ...findDownstream(state.cards, cardId)];
      for (const id of affected) {
        const c = state.cards.find((x) => x.id === id);
        if (!c) continue;
        c.invalidated = true;
        c.status = '已失效';
        c.invalidatedReason = id === cardId
          ? `前置依赖调整为 ${dependencies.length ? dependencies.join('、') : '无'}，需按 R${version} 新关系重算`
          : `前置工卡 ${cardId} 依赖关系变更，下游需按 R${version} 重算`;
        c.relationVersion = version;
        // Revert the affected stage signature; measurement/evidence values are preserved untouched.
        const sigName = STAGE_TO_SIGNATURE[c.stage];
        if (sigName) {
          const sig = state.signatures.find((s) => s.stage === sigName);
          if (sig && sig.status === '已签署') {
            sig.status = '待签署';
            sig.actor = '待指定';
            sig.time = '-';
          }
        }
      }
      // Recalculate each affected card against the new relationship.
      for (const id of affected) {
        const c = state.cards.find((x) => x.id === id);
        if (!c) continue;
        const unmet = unmetPrerequisites(state.cards, id);
        c.recalcResult = unmet.length
          ? `重算不通过：前置 ${unmet.join('、')} 未完成`
          : `重算通过：前置已满足，可继续执行`;
        c.recalcAt = now();
      }
      state.syncVersion += 1;
      state.lastSaved = now();
      state.audit.unshift({
        time: state.lastSaved,
        actor: '工艺员',
        action: '调整工卡依赖',
        detail: `${cardId} 前置 → ${dependencies.length ? dependencies.join('、') : '无'}，关系版本 R${version}，${affected.length} 张工卡失效重算，原值保留`
      });
    },
    /** Re-run recalculation for a single invalidated card; clears invalidation only when prerequisites are met. */
    recalculateCard(state, action: PayloadAction<string>) {
      const card = state.cards.find((c) => c.id === action.payload);
      if (!card) return;
      const unmet = unmetPrerequisites(state.cards, card.id);
      if (unmet.length) {
        card.invalidated = true;
        card.recalcResult = `重算不通过：前置 ${unmet.join('、')} 未完成`;
        card.recalcAt = now();
        state.audit.unshift({ time: now(), actor: '工艺员', action: '重新计算', detail: `${card.id} 前置未满足，维持失效` });
      } else {
        card.invalidated = false;
        card.status = '执行中';
        card.recalcResult = `重算通过：前置已满足，可继续执行（原值已保留）`;
        card.recalcAt = now();
        state.audit.unshift({ time: now(), actor: '工艺员', action: '重新计算', detail: `${card.id} 重算通过，恢复执行` });
      }
    },
    /** Rollback to a snapshot taken before an optimistic write. */
    restoreSnapshot(state, action: PayloadAction<Snapshot>) {
      state.cards = action.payload.cards;
      state.signatures = action.payload.signatures;
      state.relationVersion = action.payload.relationVersion;
      state.syncVersion = action.payload.syncVersion;
      state.lastSaved = action.payload.lastSaved;
      state.audit = action.payload.audit;
    },
    /** Preserve a losing submission as a conflict draft (first-writer-wins). */
    saveConflictDraft(state, action: PayloadAction<{ cardId: string; dependencies: string[]; expectedVersion: number; reason: string }>) {
      const card = state.cards.find((c) => c.id === action.payload.cardId);
      state.relationDrafts.unshift({
        id: `DRAFT-${Date.now()}`,
        cardId: action.payload.cardId,
        title: card?.title ?? '',
        dependencies: action.payload.dependencies,
        expectedVersion: action.payload.expectedVersion,
        submittedAt: now(),
        submittedBy: '工艺员',
        status: '冲突草稿',
        reason: action.payload.reason
      });
      state.audit.unshift({ time: now(), actor: '工艺员', action: '冲突草稿', detail: `${action.payload.cardId} 关系提交落后于 R${action.payload.expectedVersion}，已保留为冲突草稿` });
    },
    discardDraft(state, action: PayloadAction<string>) {
      const draft = state.relationDrafts.find((d) => d.id === action.payload);
      if (draft) draft.status = '已丢弃';
    },
    /** Demo: another engineer commits a relationship change concurrently (first-writer-wins). */
    simulateConcurrentSubmission(state) {
      state.serverRelationVersion += 1;
      state.audit.unshift({ time: now(), actor: '另一工艺员', action: '并发提交', detail: `另一工艺员已提交关系 R${state.serverRelationVersion}，先到者生效` });
    },
    refreshRelationVersion(state) {
      state.relationVersion = state.serverRelationVersion;
      state.conflictMessage = '';
    },
    setServerRelationVersion(state, action: PayloadAction<number>) {
      state.serverRelationVersion = action.payload;
    }
  }
});

// ---------- Async thunk: submit a relationship change with optimistic concurrency + rollback ----------
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const submitRelationChange = createAsyncThunk<
  { ok: boolean; reason?: string; cycle?: string[]; conflict?: boolean; newVersion?: number },
  { cardId: string; dependencies: string[] },
  { state: RootState; dispatch: AppDispatch }
>(
  'maintenance/submitRelationChange',
  async (payload, { getState, dispatch }) => {
    const state = getState().maintenance;
    const expectedVersion = state.relationVersion;
    const serverExpected = state.serverRelationVersion;
    // 1. Cycle pre-check: reject and point out the loop.
    const cycle = findCycle(state.cards, payload.cardId, payload.dependencies);
    if (cycle) return { ok: false, cycle };
    // 2. Snapshot for rollback.
    const snap: Snapshot = {
      cards: JSON.parse(JSON.stringify(state.cards)),
      signatures: JSON.parse(JSON.stringify(state.signatures)),
      relationVersion: state.relationVersion,
      syncVersion: state.syncVersion,
      lastSaved: state.lastSaved,
      audit: JSON.parse(JSON.stringify(state.audit))
    };
    // 3. Optimistic apply.
    dispatch(applyRelationChange({ cardId: payload.cardId, dependencies: payload.dependencies }));
    // 4. Mock server round-trip.
    await delay(300);
    // 5. Transient write failure: rollback to the original request.
    if (Math.random() < 0.08) {
      dispatch(restoreSnapshot(snap));
      return { ok: false, reason: '写入失败：服务器瞬时错误，已按原请求恢复，请重试。' };
    }
    // 6. Version conflict: first-writer-wins; loser keeps a conflict draft.
    if (expectedVersion !== serverExpected) {
      dispatch(restoreSnapshot(snap));
      dispatch(saveConflictDraft({
        cardId: payload.cardId,
        dependencies: payload.dependencies,
        expectedVersion,
        reason: `关系版本已更新至 R${serverExpected}，先到者已生效`
      }));
      return { ok: false, conflict: true };
    }
    // 7. Success: commit the server version.
    const newVersion = expectedVersion + 1;
    dispatch(setServerRelationVersion(newVersion));
    return { ok: true, newVersion };
  }
);

export const {
  selectCard,
  updateCard,
  setConflict,
  refreshVersion,
  toggleOffline,
  authorizeOverride,
  signStage,
  releasePackage,
  applyRelationChange,
  recalculateCard,
  restoreSnapshot,
  saveConflictDraft,
  discardDraft,
  simulateConcurrentSubmission,
  refreshRelationVersion,
  setServerRelationVersion
} = slice.actions;

export const store = configureStore({
  reducer: { maintenance: slice.reducer, [maintenanceApi.reducerPath]: maintenanceApi.reducer },
  middleware: (getDefault) => getDefault().concat(maintenanceApi.middleware)
});

store.subscribe(() => {
  if (typeof localStorage !== 'undefined') localStorage.setItem('yy61-work-package', JSON.stringify(store.getState().maintenance));
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
