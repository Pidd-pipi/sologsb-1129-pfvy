import type { TypeCase } from '../types/case';
import type { DefectLog } from '../types/defect';
import type { TypeMatrix } from '../types/matrix';
import type { ProofRecord } from '../types/proof';
import type { RecutGateState, RecutJob, RecutPlanSlot } from '../types/recut';
import { shouldDisableMatrix } from '../types/defect';

/** 代际补刻领域逻辑：两关核对、格位扫描与整批迁移前校验（均为纯函数） */

/**
 * 接替模两关核对：
 * 1. 清晰试印：至少有一张「清晰」样张；
 * 2. 缺损收口：没有结论为停用 / 待补刻的缺损记录（无记录视为已收口）。
 */
export function evaluateRecutGate(
  successor: TypeMatrix | undefined,
  proofs: ProofRecord[],
  defects: DefectLog[],
): RecutGateState {
  const messages: string[] = [];
  if (!successor) {
    return {
      hasClearProof: false,
      defectsClosed: false,
      successorAvailable: false,
      ready: false,
      messages: ['接替模档案不存在'],
    };
  }
  const hasClearProof = proofs.some((p) => p.matrixId === successor.id && p.clarity === '清晰');
  if (!hasClearProof) messages.push('尚无「清晰」试印样张');

  const openDefects = defects.filter(
    (d) => d.matrixId === successor.id && shouldDisableMatrix(d.availability),
  );
  const defectsClosed = openDefects.length === 0;
  if (!defectsClosed) messages.push(`仍有 ${openDefects.length} 条缺损未收口`);

  const successorAvailable = successor.availability === '可用';
  if (!hasClearProof || !defectsClosed) {
    if (successor.availability !== '验收中') {
      messages.push('接替模需先回到「验收中」等待两关齐备');
    }
  } else if (!successorAvailable) {
    messages.push('两关已齐备，待自动转为可用');
  }

  return {
    hasClearProof,
    defectsClosed,
    successorAvailable,
    ready: hasClearProof && defectsClosed,
    messages,
  };
}

/** 扫描全部字盘，得到旧模当前占有的格位清单与涉及字盘的版本快照 */
export function scanPlanSlots(
  oldMatrixId: string,
  cases: TypeCase[],
): { planSlots: RecutPlanSlot[]; caseVersions: Record<string, number> } {
  const planSlots: RecutPlanSlot[] = [];
  const caseVersions: Record<string, number> = {};
  for (const c of cases) {
    const hits = c.slots
      .filter((s) => s.matrixId === oldMatrixId)
      .sort((a, b) => a.row - b.row || a.col - b.col);
    if (hits.length === 0) continue;
    caseVersions[c.id] = c.version;
    for (const s of hits) {
      planSlots.push({
        caseId: c.id,
        caseCode: c.code,
        row: s.row,
        col: s.col,
        character: s.character,
      });
    }
  }
  return { planSlots, caseVersions };
}

/** 格位的文字坐标，例：B3 */
export function slotLabel(slot: Pick<RecutPlanSlot, 'row' | 'col'>): string {
  return `${String.fromCharCode(65 + slot.row)}${slot.col + 1}`;
}

export interface RecutBatchIssue {
  jobId: string;
  /** 致命问题会整批拒绝；警告仅提示（旧模当前不在任何格位上） */
  severity: 'error' | 'warning';
  message: string;
}

export interface RecutBatchCheck {
  issues: RecutBatchIssue[];
  errors: RecutBatchIssue[];
  warnings: RecutBatchIssue[];
  /** 无致命问题时才允许提交迁移 */
  valid: boolean;
}

/**
 * 批量迁移前核对（在事务内用最新数据再跑一遍，保证两个标签页同时提交只有一份生效）：
 * - 工程状态必须是「待迁移」；
 * - 接替模必须可用（清晰试印、缺损收口两关齐备的结果）；
 * - 字盘版本必须与核对快照一致（版本被改过说明别的标签页 / 页面已动过格位）；
 * - 计划内每个格位当前必须仍是这枚旧模（旧模被取出、调走即拒绝）；
 * - 旧模不得仍出现在计划之外的格位上（别盘 / 别格引用未纳入本批，整批拒绝）。
 */
export function checkRecutBatch(
  jobs: RecutJob[],
  cases: TypeCase[],
  matricesById: Map<string, TypeMatrix>,
): RecutBatchCheck {
  const issues: RecutBatchIssue[] = [];
  const caseById = new Map(cases.map((c) => [c.id, c]));

  for (const job of jobs) {
    const tag = `「${job.character}」${job.code}`;
    if (job.status !== '待迁移') {
      issues.push({ jobId: job.id, severity: 'error', message: `${tag}：工程状态为「${job.status}」，不在待迁移清单` });
      continue;
    }

    const successor = matricesById.get(job.successorMatrixId);
    if (!successor || successor.availability !== '可用') {
      issues.push({
        jobId: job.id,
        severity: 'error',
        message: `${tag}：接替模不可用（${successor ? successor.availability : '档案缺失'}），整批不予迁移`,
      });
    }

    // 旧模在所有字盘上的现存格位
    const liveByCase = new Map<string, { row: number; col: number }[]>();
    for (const c of cases) {
      const hits = c.slots.filter((s) => s.matrixId === job.oldMatrixId);
      if (hits.length) liveByCase.set(c.id, hits.map((s) => ({ row: s.row, col: s.col })));
    }

    const plannedKeys = new Set<string>();
    for (const slot of job.planSlots) {
      plannedKeys.add(`${slot.caseId}:${slot.row}-${slot.col}`);
    }

    // 字盘版本核对（乐观锁）
    for (const [caseId, snapshotVersion] of Object.entries(job.caseVersions)) {
      const live = caseById.get(caseId);
      if (!live) {
        issues.push({ jobId: job.id, severity: 'error', message: `${tag}：计划中的字盘已被删除` });
        continue;
      }
      if (live.version !== snapshotVersion) {
        issues.push({
          jobId: job.id,
          severity: 'error',
          message: `${tag}：字盘 ${live.code} 版本已变化（v${snapshotVersion} → v${live.version}），请重新核对格位`,
        });
      }
    }

    // 计划内格位核对：必须仍由旧模占着
    for (const slot of job.planSlots) {
      const live = caseById.get(slot.caseId);
      const hit = live?.slots.find((s) => s.row === slot.row && s.col === slot.col);
      if (!live) continue;
      if (!hit) {
        issues.push({
          jobId: job.id,
          severity: 'error',
          message: `${tag}：字盘 ${slot.caseCode} 的 ${slotLabel(slot)} 格已空，请重新核对`,
        });
      } else if (hit.matrixId !== job.oldMatrixId) {
        issues.push({
          jobId: job.id,
          severity: 'error',
          message: `${tag}：字盘 ${slot.caseCode} 的 ${slotLabel(slot)} 格已被其他字模占用，请重新核对`,
        });
      }
    }

    // 别盘 / 别格引用核对：旧模现存格位必须全部包含在计划内
    liveByCase.forEach((slots, caseId) => {
      const liveCase = caseById.get(caseId);
      for (const s of slots) {
        if (!plannedKeys.has(`${caseId}:${s.row}-${s.col}`)) {
          issues.push({
            jobId: job.id,
            severity: 'error',
            message: `${tag}：旧模仍被字盘 ${liveCase?.code ?? caseId} 的 ${slotLabel(s)} 格引用（不在本批计划内），整批拒绝迁移`,
          });
        }
      }
    });

    if (job.planSlots.length === 0) {
      issues.push({
        jobId: job.id,
        severity: 'warning',
        message: `${tag}：旧模当前不在任何字盘格位上，迁移只切换代际档案、不动格位`,
      });
    }
  }

  return {
    issues,
    errors: issues.filter((i) => i.severity === 'error'),
    warnings: issues.filter((i) => i.severity === 'warning'),
    valid: issues.every((i) => i.severity !== 'error'),
  };
}
