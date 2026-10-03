import { createApi } from '@reduxjs/toolkit/query/react';
import type { BaseQueryFn } from '@reduxjs/toolkit/query';
import { findDependencyCycle } from './graph';

export type WorkCard = {
  id: string;
  title: string;
  zone: string;
  revision: string;
  estimated: number;
  dependencies: string[];
  tolerance: string;
  evidence: string;
  witness: string;
  status: '未开始' | '执行中' | '待授权' | '已完成' | '已失效';
  measurement: string;
  finding: string;
  stage: string;
};

/** 服务端当前关系版本：工卡依赖、执行状态、放行门禁共用这一份版本。 */
export const SERVER_RELATION_VERSION = 2;

const packageData = {
  id: 'WP-B7891-04',
  aircraft: 'B-7891',
  type: 'B737-800',
  check: '48A 定检',
  station: '上海浦东 · H3 机库',
  plannedStart: '2026-09-28 06:00',
  plannedEnd: '2026-09-30 18:00',
  revision: 'WP R7',
  serverRevision: 7,
  relationVersion: SERVER_RELATION_VERSION,
  tasks: [
    { id: 'CARD-01', title: '右主起落架收放检查', zone: '起落架舱 RH', revision: 'R7', estimated: 3.5, dependencies: [], tolerance: '间隙 1.2–2.0 mm', evidence: '近照 + 动作记录', witness: '检验员', status: '已完成', measurement: '1.62 mm', finding: '正常', stage: '机械签署' },
    { id: 'CARD-02', title: '发动机 2 风扇叶片孔探', zone: '发动机 2', revision: 'R7', estimated: 4.2, dependencies: ['CARD-01'], tolerance: '凹坑 ≤ 0.3 mm', evidence: '孔探照片 + 视频', witness: '发动机工程师', status: '执行中', measurement: '', finding: '', stage: '发动机签署' },
    { id: 'CARD-03', title: '液压系统压力保持测试', zone: '轮舱 / 系统 A', revision: 'R6', estimated: 2.0, dependencies: ['CARD-01'], tolerance: '≥ 2850 psi / 10 min', evidence: '压力仪记录', witness: '质量检验', status: '待授权', measurement: '2762 psi', finding: '低于容差，等待授权', stage: '系统签署' },
    { id: 'CARD-04', title: '前起落架时寿件核对', zone: '前起落架', revision: 'R7', estimated: 1.5, dependencies: [], tolerance: '剩余循环 ≥ 500', evidence: '件号照片 + 履历页', witness: '检验员', status: '已完成', measurement: '剩余 836 循环', finding: '正常', stage: '适航签署' },
    { id: 'CARD-05', title: 'AD 2024-15-03 执行确认', zone: '机身后段', revision: 'R7', estimated: 2.5, dependencies: ['CARD-04'], tolerance: '按 AD 标准施工', evidence: '施工记录 + 签署', witness: '放行人员', status: '未开始', measurement: '', finding: '', stage: '适航签署' },
    { id: 'CARD-06', title: '客舱应急设备检查', zone: '客舱全舱', revision: 'R7', estimated: 2.8, dependencies: [], tolerance: '全部在有效期内', evidence: '清单复核', witness: '客舱检验', status: '未开始', measurement: '', finding: '', stage: '客舱签署' },
    { id: 'CARD-07', title: 'APU 排故后试车', zone: 'APU 舱', revision: 'R5', estimated: 3.0, dependencies: ['CARD-03'], tolerance: '参数在 AMM 范围', evidence: '试车数据 + 油样', witness: '动力工程师', status: '未开始', measurement: '', finding: '', stage: '动力签署' },
    { id: 'CARD-08', title: '重复缺陷趋势复核', zone: '全机', revision: 'R7', estimated: 1.0, dependencies: ['CARD-02', 'CARD-03'], tolerance: '无新增重复缺陷', evidence: '近 3 次记录', witness: '质量经理', status: '执行中', measurement: '发现 2 次压力偏低', finding: '移交可靠性分析', stage: '放行签署' }
  ] as WorkCard[]
};

const mockBaseQuery: BaseQueryFn = async (arg) => {
  await new Promise((resolve) => setTimeout(resolve, 180));
  if (typeof arg === 'string' && arg === 'package') return { data: packageData };
  if (typeof arg === 'object' && arg !== null && 'url' in arg) {
    const request = arg as { url: string };
    if (request.url === 'package') return { data: packageData };
  }
  return { error: { status: 404, data: 'Not found' } };
};

export type RelationChangePayload = { cardId: string; dependencies: string[]; version: number; actor: string };

/** 服务端最近一次生效的关系变更，用于 409 时把先到者的结果回传给后到者。 */
let lastRelationChange: RelationChangePayload | null = null;

/** 服务端落库：成环拒绝，否则应用依赖并递增关系版本。 */
function applyServerRelation(cardId: string, dependencies: string[], actor: string): { cycle: string[] | null } {
  const nextTasks = packageData.tasks.map((task) => (task.id === cardId ? { ...task, dependencies } : task));
  const cycle = findDependencyCycle(nextTasks);
  if (cycle) return { cycle };
  packageData.tasks = nextTasks;
  packageData.relationVersion += 1;
  lastRelationChange = { cardId, dependencies, version: packageData.relationVersion, actor };
  return { cycle: null };
}

export const maintenanceApi = createApi({
  reducerPath: 'maintenanceApi',
  baseQuery: mockBaseQuery,
  tagTypes: ['Package'],
  endpoints: (builder) => ({
    getWorkPackage: builder.query<typeof packageData, void>({
      query: () => 'package',
      providesTags: ['Package']
    }),
    submitCard: builder.mutation<{ accepted: boolean; revision: number }, { cardId: string; expectedRevision: number; measurement: string; finding: string }>({
      queryFn: async (payload) => {
        await new Promise((resolve) => setTimeout(resolve, 240));
        if (payload.expectedRevision !== packageData.serverRevision) {
          return { error: { status: 409, data: { message: '版本冲突：服务器已有更新，请刷新后重试。' } } };
        }
        return { data: { accepted: true, revision: packageData.serverRevision + 1 } };
      },
      invalidatesTags: ['Package']
    }),
    updateRelations: builder.mutation<
      { applied: boolean; relationVersion: number },
      { cardId: string; dependencies: string[]; expectedRelationVersion: number; actor: string; simulateFailure?: boolean }
    >({
      queryFn: async (payload) => {
        await new Promise((resolve) => setTimeout(resolve, 260));
        if (payload.simulateFailure) {
          return { error: { status: 500, data: { message: '写入失败：关系存储不可用，服务端未产生任何变更。' } } };
        }
        if (payload.expectedRelationVersion !== packageData.relationVersion) {
          return {
            error: {
              status: 409,
              data: {
                message: `版本冲突：另一工艺员已先将关系版本升至 V${packageData.relationVersion}，先到者生效，本次提交已留存为冲突草稿。`,
                currentVersion: packageData.relationVersion,
                winningChange: lastRelationChange
              }
            }
          };
        }
        const { cycle } = applyServerRelation(payload.cardId, payload.dependencies, payload.actor);
        if (cycle) {
          return { error: { status: 422, data: { message: `新关系成环，已拒绝：${cycle.join(' → ')}`, cycle } } };
        }
        return { data: { applied: true, relationVersion: packageData.relationVersion } };
      },
      invalidatesTags: ['Package']
    }),
    externalRelationChange: builder.mutation<{ relationVersion: number }, { cardId: string; dependencies: string[]; actor: string }>({
      queryFn: async (payload) => {
        await new Promise((resolve) => setTimeout(resolve, 160));
        const { cycle } = applyServerRelation(payload.cardId, payload.dependencies, payload.actor);
        if (cycle) {
          return { error: { status: 422, data: { message: `新关系成环，已拒绝：${cycle.join(' → ')}`, cycle } } };
        }
        return { data: { relationVersion: packageData.relationVersion } };
      },
      invalidatesTags: ['Package']
    })
  })
});

export const { useGetWorkPackageQuery, useSubmitCardMutation, useUpdateRelationsMutation, useExternalRelationChangeMutation } = maintenanceApi;
