import type { MatrixInput } from './matrix';

/**
 * 代际补刻（RecutJob）：
 * 待补刻旧模不就地复用，而是沿用旧编号另刻一枚「接替模」（新实体、新一代）；
 * 清晰试印与缺损收口两关齐备后，才把旧模在字盘格位上的位置整批迁给接替模。
 * 旧模、旧缺损与旧试印样张一律保留，只通过代际与谱系 id 区分实体。
 */

/** 补刻工程状态 */
export const RECUT_STATUSES = ['待验收', '待迁移', '已迁移', '已取消'] as const;
export type RecutStatus = (typeof RECUT_STATUSES)[number];

/** 进行中（尚未收口）的状态：关页再开后从这两个状态继续 */
export const RECUT_ACTIVE_STATUSES: RecutStatus[] = ['待验收', '待迁移'];

/** 补刻工程里计划迁走的一个格位（核对时按字盘分组使用） */
export interface RecutPlanSlot {
  caseId: string;
  caseCode: string;
  row: number;
  col: number;
  character: string;
}

export interface RecutJob {
  id: string;
  /** 旧模 id */
  oldMatrixId: string;
  /** 接替模 id */
  successorMatrixId: string;
  /** 沿用的字模编号 */
  code: string;
  character: string;
  /** 接替模代际（旧模代际 +1） */
  successorGeneration: number;
  status: RecutStatus;
  engraver: string;
  /** 建立接替模时记录的补刻原因 */
  reason: string;
  /** 待迁移格位快照（建立工程与重新核对时扫描字盘得出） */
  planSlots: RecutPlanSlot[];
  /** 涉及字盘的布局版本快照：caseId → version，迁移前据此做乐观锁核对 */
  caseVersions: Record<string, number>;
  /** 最近一次整批核对给出的问题（迁移失败后重开页面仍可见） */
  lastError: string;
  createdAt: string;
  updatedAt: string;
  /** 完成迁移时间 */
  migratedAt: string;
  /** 取消时间 */
  canceledAt: string;
}

/** 建立接替模的入参：在旧模字面信息基础上允许改刻工、年代与备注 */
export type StartRecutInput = Pick<MatrixInput, 'engraver' | 'madeYear' | 'note'> & {
  oldMatrixId: string;
  reason: string;
};

/** 接替模缺损收口的入参 */
export interface CloseDefectInput {
  jobId: string;
  operator: string;
  note?: string;
}

/** 清晰试印收口的入参（压力 / 印次 / 用墨沿用试印页的枚举与区间） */
export interface ClearProofInput {
  jobId: string;
  pressureKg: number;
  ink: string;
  impressions: number;
  sampleNo: string;
  proofDate: string;
  note?: string;
}

/** 两关收口情况的核对结果（纯函数，供页面与 store 共用） */
export interface RecutGateState {
  /** 清晰试印：接替模至少有一张「清晰」样张 */
  hasClearProof: boolean;
  /** 缺损收口：接替模没有结论为停用 / 待补刻的缺损（无缺损记录视为已收口） */
  defectsClosed: boolean;
  /** 接替模当前可用性（正常应为「验收中」，收口后自动转「可用」） */
  successorAvailable: boolean;
  /** 两关齐备，可以进入待迁移 */
  ready: boolean;
  /** 逐条待办提示 */
  messages: string[];
}
