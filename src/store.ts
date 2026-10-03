import { configureStore, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { maintenanceApi, SERVER_RELATION_VERSION } from './api';
import { collectDownstream, findDependencyCycle, upstreamChain } from './graph';

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
  invalidReason: string;
  recalcResult: string;
};

export type RelationChangeRecord = {
  version: number;
  time: string;
  actor: string;
  cardId: string;
  from: string[];
  to: string[];
  invalidated: string[];
  returnedStages: string[];
};

export type RelationDraft = {
  id: string;
  cardId: string;
  nextDeps: string[];
  baseVersion: number;
  serverVersion: number;
  reason: '版本冲突' | '写入失败';
  actor: string;
  time: string;
};

export type RelationSnapshot = {
  cards: OfflineCard[];
  signatures: StageSignature[];
  relationVersion: number;
  relationLog: RelationChangeRecord[];
};

type MaintenanceState = {
  cards: OfflineCard[];
  activeCardId: string;
  syncVersion: number;
  serverVersion: number;
  relationVersion: number;
  relationLog: RelationChangeRecord[];
  relationDrafts: RelationDraft[];
  legacyUpgraded: boolean;
  offline: boolean;
  lastSaved: string;
  conflictMessage: string;
  signatures: StageSignature[];
  released: boolean;
  audit: { time: string; actor: string; action: string; detail: string }[];
};

const timestamp = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

const initialCards: OfflineCard[] = [
  { id: 'CARD-01', title: '右主起落架收放检查', zone: '起落架舱 RH', estimated: 3.5, dependencies: [], tolerance: '间隙 1.2–2.0 mm', evidence: '近照 + 动作记录', witness: '检验员', status: '已完成', measurement: '1.62 mm', finding: '正常', stage: '机械签署', invalidReason: '', recalcResult: '' },
  { id: 'CARD-02', title: '发动机 2 风扇叶片孔探', zone: '发动机 2', estimated: 4.2, dependencies: ['CARD-01'], tolerance: '凹坑 ≤ 0.3 mm', evidence: '孔探照片 + 视频', witness: '发动机工程师', status: '执行中', measurement: '', finding: '', stage: '发动机签署', invalidReason: '', recalcResult: '' },
  { id: 'CARD-03', title: '液压系统压力保持测试', zone: '轮舱 / 系统 A', estimated: 2.0, dependencies: ['CARD-01'], tolerance: '≥ 2850 psi / 10 min', evidence: '压力仪记录', witness: '质量检验', status: '待授权', measurement: '2762 psi', finding: '低于容差，等待授权', stage: '系统签署', invalidReason: '', recalcResult: '' },
  { id: 'CARD-04', title: '前起落架时寿件核对', zone: '前起落架', estimated: 1.5, dependencies: [], tolerance: '剩余循环 ≥ 500', evidence: '件号照片 + 履历页', witness: '检验员', status: '已完成', measurement: '剩余 836 循环', finding: '正常', stage: '适航签署', invalidReason: '', recalcResult: '' },
  { id: 'CARD-05', title: 'AD 2024-15-03 执行确认', zone: '机身后段', estimated: 2.5, dependencies: ['CARD-04'], tolerance: '按 AD 标准施工', evidence: '施工记录 + 签署', witness: '放行人员', status: '未开始', measurement: '', finding: '', stage: '适航签署', invalidReason: '', recalcResult: '' },
  { id: 'CARD-06', title: '客舱应急设备检查', zone: '客舱全舱', estimated: 2.8, dependencies: [], tolerance: '全部在有效期内', evidence: '清单复核', witness: '客舱检验', status: '未开始', measurement: '', finding: '', stage: '客舱签署', invalidReason: '', recalcResult: '' },
  { id: 'CARD-07', title: 'APU 排故后试车', zone: 'APU 舱', estimated: 3.0, dependencies: ['CARD-03'], tolerance: '参数在 AMM 范围', evidence: '试车数据 + 油样', witness: '动力工程师', status: '未开始', measurement: '', finding: '', stage: '动力签署', invalidReason: '', recalcResult: '' },
  { id: 'CARD-08', title: '重复缺陷趋势复核', zone: '全机', estimated: 1.0, dependencies: ['CARD-02', 'CARD-03'], tolerance: '无新增重复缺陷', evidence: '近 3 次记录', witness: '质量经理', status: '执行中', measurement: '发现 2 次压力偏低', finding: '移交可靠性分析', stage: '放行签署', invalidReason: '', recalcResult: '' }
];

const defaultState: MaintenanceState = {
  cards: initialCards,
  activeCardId: 'CARD-03',
  syncVersion: 7,
  serverVersion: 7,
  relationVersion: SERVER_RELATION_VERSION,
  relationLog: [],
  relationDrafts: [],
  legacyUpgraded: false,
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
  ]
};

/** 旧工作包缺少关系版本时先兼容升级：按服务器关系版本对齐，并补齐逐卡失效/重算字段。 */
export function migrateState(saved: Partial<MaintenanceState>): MaintenanceState {
  const merged: MaintenanceState = {
    ...defaultState,
    ...saved,
    cards: (saved.cards ?? defaultState.cards).map((card) => ({ ...card, invalidReason: card.invalidReason ?? '', recalcResult: card.recalcResult ?? '' })),
    signatures: saved.signatures ?? defaultState.signatures,
    audit: saved.audit ?? defaultState.audit
  };
  if (saved.relationVersion === undefined) {
    merged.relationVersion = SERVER_RELATION_VERSION;
    merged.relationLog = [];
    merged.relationDrafts = [];
    merged.legacyUpgraded = true;
    merged.audit = [
      { time: timestamp(), actor: '系统', action: '兼容升级', detail: `旧工作包缺少关系版本，已按服务器关系版本 V${SERVER_RELATION_VERSION} 升级，工卡依赖、执行状态与放行门禁已对齐到同一份版本关系` },
      ...merged.audit
    ];
  } else {
    merged.relationLog = saved.relationLog ?? [];
    merged.relationDrafts = saved.relationDrafts ?? [];
    merged.legacyUpgraded = saved.legacyUpgraded ?? false;
  }
  return merged;
}

function loadInitialState(): MaintenanceState {
  if (typeof localStorage === 'undefined') return defaultState;
  const raw = localStorage.getItem('yy61-work-package');
  if (!raw) return defaultState;
  try {
    return migrateState(JSON.parse(raw) as Partial<MaintenanceState>);
  } catch {
    return defaultState;
  }
}

const slice = createSlice({
  name: 'maintenance',
  initialState: loadInitialState(),
  reducers: {
    selectCard(state, action: PayloadAction<string>) {
      state.activeCardId = action.payload;
    },
    updateCard(state, action: PayloadAction<Partial<OfflineCard>>) {
      const card = state.cards.find((item) => item.id === state.activeCardId);
      if (!card) return;
      Object.assign(card, action.payload);
      state.syncVersion += 1;
      state.lastSaved = timestamp();
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
      state.audit.unshift({ time: timestamp(), actor: '放行授权人', action: '授权继续', detail: `${card.id} 超差放行审批` });
    },
    /** 应用一次关系变更：成环拒绝；下游工卡失效重算（原值保留）；受影响阶段签字退回。 */
    applyRelationChange(state, action: PayloadAction<{ cardId: string; nextDeps: string[]; newVersion: number; actor: string }>) {
      const { cardId, nextDeps, newVersion, actor } = action.payload;
      const card = state.cards.find((item) => item.id === cardId);
      if (!card) return;
      const preview = state.cards.map((item) => ({ id: item.id, dependencies: item.id === cardId ? nextDeps : item.dependencies }));
      const cycle = findDependencyCycle(preview);
      const time = timestamp();
      if (cycle) {
        state.audit.unshift({ time, actor, action: '依赖成环拒绝', detail: `${cardId} 依赖调整被拒绝，回路：${cycle.join(' → ')}` });
        return;
      }
      const prevVersion = state.relationVersion;
      const fromDeps = [...card.dependencies];
      card.dependencies = [...nextDeps];
      const affected = [cardId, ...collectDownstream(cardId, state.cards)];
      const invalidated: string[] = [];
      const returnedStages = new Set<string>();
      affected.forEach((id) => {
        const target = state.cards.find((item) => item.id === id);
        if (!target) return;
        const chain = upstreamChain(id, state.cards);
        const reason = id === cardId
          ? `本卡前置由 ${fromDeps.join('、') || '无'} 调整为 ${nextDeps.join('、') || '无'}（V${prevVersion} → V${newVersion}）`
          : `上游 ${cardId} 依赖调整（V${prevVersion} → V${newVersion}），本卡需失效重算`;
        if (target.status !== '未开始') {
          target.status = '已失效';
          target.invalidReason = reason;
          target.recalcResult = `新前置链 ${chain.join(' → ') || '无'}；现场测量与证据原值保留，重新执行后按 V${newVersion} 复核`;
          invalidated.push(id);
        } else {
          target.recalcResult = `前置链已重算：${chain.join(' → ') || '无'}；开工前按 V${newVersion} 关系确认`;
        }
        const stageName = target.stage.replace('签署', '');
        const signature = state.signatures.find((item) => item.stage === stageName);
        if (signature && signature.status === '已签署') {
          signature.status = '待签署';
          signature.actor = '待指定';
          signature.time = '-';
          returnedStages.add(stageName);
        }
      });
      const returned = [...returnedStages];
      state.relationVersion = newVersion;
      state.relationLog.unshift({ version: newVersion, time, actor, cardId, from: fromDeps, to: [...nextDeps], invalidated, returnedStages: returned });
      state.audit.unshift({ time, actor, action: '依赖调整', detail: `${cardId} 前置 ${fromDeps.join('、') || '无'} → ${nextDeps.join('、') || '无'}，关系版本升至 V${newVersion}` });
      if (invalidated.length > 0) {
        state.audit.unshift({ time, actor: '系统', action: '失效重算', detail: `${invalidated.join('、')} 已失效，现场测量与证据原值保留，等待重算` });
      }
      if (returned.length > 0) {
        state.audit.unshift({ time, actor: '系统', action: '签字退回', detail: `${returned.join('、')}阶段签字已退回，需重新签署` });
      }
    },
    /** 写入失败或版本冲突时按快照回滚，恢复原请求之前的状态。 */
    rollbackRelationChange(state, action: PayloadAction<RelationSnapshot>) {
      state.cards = action.payload.cards;
      state.signatures = action.payload.signatures;
      state.relationVersion = action.payload.relationVersion;
      state.relationLog = action.payload.relationLog;
    },
    confirmRelationChange(state, action: PayloadAction<{ newVersion: number }>) {
      state.relationVersion = action.payload.newVersion;
    },
    saveRelationDraft(state, action: PayloadAction<{ cardId: string; nextDeps: string[]; baseVersion: number; serverVersion: number; reason: '版本冲突' | '写入失败' }>) {
      const time = timestamp();
      state.relationDrafts.unshift({ id: `DRAFT-${Date.now()}`, ...action.payload, actor: '宋杰（本机）', time });
      state.audit.unshift({
        time,
        actor: '系统',
        action: action.payload.reason === '版本冲突' ? '冲突草稿' : '写入失败回滚',
        detail: `${action.payload.cardId} 依赖修改未生效（基于 V${action.payload.baseVersion}，服务器 V${action.payload.serverVersion}），原请求已留存为草稿`
      });
    },
    discardRelationDraft(state, action: PayloadAction<string>) {
      state.relationDrafts = state.relationDrafts.filter((draft) => draft.id !== action.payload);
    },
    /** 失效工卡按当前关系版本重算并恢复执行，现场测量与证据原值保留。 */
    recalcCard(state, action: PayloadAction<string>) {
      const card = state.cards.find((item) => item.id === action.payload);
      if (!card || card.status !== '已失效') return;
      const time = timestamp();
      card.status = '执行中';
      card.invalidReason = '';
      card.recalcResult = `已于 ${time} 按关系版本 V${state.relationVersion} 重算并恢复执行；原测量值与证据保留待复核`;
      state.audit.unshift({ time, actor: '当前用户', action: '失效重算', detail: `${card.id} 按 V${state.relationVersion} 前置链重算，恢复执行，原值保留` });
    },
    appendAudit(state, action: PayloadAction<{ action: string; detail: string; actor?: string }>) {
      state.audit.unshift({ time: timestamp(), actor: action.payload.actor ?? '当前用户', action: action.payload.action, detail: action.payload.detail });
    },
    ackLegacyUpgrade(state) {
      state.legacyUpgraded = false;
    },
    signStage(state, action: PayloadAction<string>) {
      const signature = state.signatures.find((item) => item.stage === action.payload);
      if (!signature) return;
      signature.status = '已签署';
      signature.actor = `${action.payload}负责人`;
      signature.time = timestamp();
      state.audit.unshift({ time: signature.time, actor: signature.actor, action: '阶段签署', detail: `${action.payload}阶段确认完成` });
    },
    releasePackage(state) {
      const hasBlockers = state.cards.some((card) => card.status === '待授权' || card.status === '已失效');
      const allSigned = state.signatures.every((item) => item.status === '已签署');
      if (!hasBlockers && allSigned && state.relationDrafts.length === 0) {
        state.released = true;
        state.audit.unshift({ time: timestamp(), actor: '质量经理', action: '锁定放行', detail: `工作包 R7 已锁定并形成放行基线（关系版本 V${state.relationVersion}）` });
      }
    }
  }
});

export const {
  selectCard,
  updateCard,
  setConflict,
  refreshVersion,
  toggleOffline,
  authorizeOverride,
  applyRelationChange,
  rollbackRelationChange,
  confirmRelationChange,
  saveRelationDraft,
  discardRelationDraft,
  recalcCard,
  appendAudit,
  ackLegacyUpgrade,
  signStage,
  releasePackage
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
