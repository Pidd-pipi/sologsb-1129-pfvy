/** 代际补刻批次（RecarveBatch）：待补刻字模建立接替模、试印收口、迁移格位的全过程草稿 */

/** 批次状态：草稿（可继续）/ 已迁移（完成）/ 已拒绝（可重试） */
export const RECARVE_BATCH_STATUSES = ['draft', 'migrated', 'rejected'] as const;
export type RecarveBatchStatus = (typeof RECARVE_BATCH_STATUSES)[number];

/** 计划迁移的一个格位：把 fromMatrixId（旧模）换成 toMatrixId（接替模） */
export interface RecarvePlanSlot {
  row: number;
  col: number;
  character: string;
  fromMatrixId: string;
  toMatrixId: string;
}

/** 计划迁移的一个字盘：记录草稿建立时核对的字盘版本与格位 */
export interface RecarvePlanCase {
  caseId: string;
  caseCode: string;
  /** 草稿建立时核对的字盘版本号 */
  caseVersion: number;
  slots: RecarvePlanSlot[];
}

/** 迁移收口条件：清晰试印 + 缺损收口 + 格位核对，三者齐备方可迁移 */
export interface RecarveGate {
  /** 接替模是否已有清晰试印样张 */
  proofClear: boolean;
  /** 清晰试印样张编号（最近一条） */
  proofSampleNo: string;
  /** 旧模缺损是否已收口 */
  defectClosed: boolean;
  /** 字盘版本与格位是否核对通过 */
  caseChecked: boolean;
  /** 核对未通过的原因（逐条） */
  caseIssues: string[];
}

export interface RecarveBatch {
  id: string;
  /** 旧模（待补刻字模）id */
  sourceMatrixId: string;
  /** 接替模 id */
  successorMatrixId: string;
  /** 世系 id（接替模继承旧模 lineageId） */
  lineageId: string;
  status: RecarveBatchStatus;
  /** 迁移计划：每个字盘把旧模格位迁到接替模 */
  plan: RecarvePlanCase[];
  /** 收口条件快照（每次核对刷新） */
  gate: RecarveGate;
  /** 最近一次被拒绝的原因（status = rejected 时） */
  rejectReason: string;
  operator: string;
  createdAt: string;
  updatedAt: string;
  confirmedAt: string;
}

/** 空收口条件 */
export function emptyGate(): RecarveGate {
  return {
    proofClear: false,
    proofSampleNo: '',
    defectClosed: false,
    caseChecked: false,
    caseIssues: [],
  };
}

/** 批次是否仍可继续（草稿或被拒后重试） */
export function isBatchOpen(status: RecarveBatchStatus): boolean {
  return status === 'draft' || status === 'rejected';
}

/** 批次状态的中文文案 */
export function batchStatusLabel(status: RecarveBatchStatus): string {
  switch (status) {
    case 'draft':
      return '草稿中';
    case 'migrated':
      return '已迁移';
    case 'rejected':
      return '已拒绝·可重试';
  }
}
