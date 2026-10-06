import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import { useCaseStore } from './caseStore';
import { useMatrixStore } from './matrixStore';
import type { DefectLog } from '../types/defect';
import type { TypeMatrix } from '../types/matrix';
import type { ProofRecord } from '../types/proof';
import type {
  RecarveBatch,
  RecarveGate,
  RecarvePlanCase,
  RecarvePlanSlot,
} from '../types/recarve';
import { emptyGate } from '../types/recarve';
import { matrixIdsOf } from '../utils/layout';
import { makeId, toPlain } from '../utils/format';
import { notifyRecarveChanged, subscribeRecarveChanged, withRecarveLock } from '../utils/lock';

interface RecarveState {
  batches: RecarveBatch[];
  loaded: boolean;
  loading: boolean;
  error: string;
  load: () => Promise<void>;
  /** 为待补刻字模建立接替模（新模沿用旧编号，代际 +1），并生成迁移草稿 */
  createSuccessor: (sourceMatrixId: string, operator: string) => Promise<RecarveBatch>;
  /** 按当前库内数据重新核对收口条件并落盘 */
  refreshGate: (batchId: string) => Promise<RecarveGate>;
  /** 确认迁移：跨标签页互斥 + 整批校验，失败则草稿转 rejected 可重试 */
  confirmMigration: (batchId: string) => Promise<{ ok: boolean; reasons: string[] }>;
  /** 被拒绝的批次修改后重试（回到草稿并重新校验迁移） */
  retryBatch: (batchId: string) => Promise<{ ok: boolean; reasons: string[] }>;
  /** 放弃草稿（仅删除批次，接替模与档案保留） */
  discardBatch: (batchId: string) => Promise<void>;
}

const byCreatedDesc = (a: RecarveBatch, b: RecarveBatch) => (a.createdAt < b.createdAt ? 1 : -1);

/** 取字模代际（兼容旧档案缺失字段，按初代处理） */
function generationOf(m: TypeMatrix): number {
  return m.generation && m.generation > 0 ? m.generation : 1;
}

/** 由库内最新数据重新计算收口条件 */
async function computeGate(batch: RecarveBatch): Promise<RecarveGate> {
  const gate = emptyGate();
  const issues: string[] = [];

  const successor = await db.matrices.get(batch.successorMatrixId);
  if (!successor) {
    issues.push('接替模档案不存在或已被删除');
  } else {
    // 清晰试印：接替模至少有一条 clarity = 清晰 的试印记录
    const proofs: ProofRecord[] = await db.proofs.where('matrixId').equals(successor.id).toArray();
    const clearProofs = proofs
      .filter((p) => p.clarity === '清晰')
      .sort((a, b) => (a.proofDate < b.proofDate ? 1 : -1));
    if (clearProofs.length > 0) {
      gate.proofClear = true;
      gate.proofSampleNo = clearProofs[0].sampleNo;
    } else {
      issues.push('接替模尚无清晰试印样张（需登记清晰度为「清晰」的试印）');
    }
  }

  // 缺损收口：旧模存在 closed = true 的收口记录
  const defects: DefectLog[] = await db.defects.where('matrixId').equals(batch.sourceMatrixId).toArray();
  if (defects.some((d) => d.closed)) {
    gate.defectClosed = true;
  } else {
    issues.push('旧模缺损尚未收口');
  }

  // 格位核对：逐盘核对版本与格位，并检查是否还有别盘引用
  const source = await db.matrices.get(batch.sourceMatrixId);
  if (!source) {
    issues.push('旧模档案不存在或已被删除');
  } else {
    const holdingCases = await db.cases.where('matrixId').equals(source.id).toArray();
    const holdingIds = new Set(holdingCases.map((c) => c.id));
    const plannedIds = new Set(batch.plan.map((p) => p.caseId));

    // 仍有别盘引用：当前引用集合超出计划集合
    for (const c of holdingCases) {
      if (!plannedIds.has(c.id)) {
        issues.push(`字盘 ${c.code} 仍引用旧模，未列入迁移计划`);
      }
    }
    // 计划中的字盘已不再引用旧模
    for (const p of batch.plan) {
      if (!holdingIds.has(p.caseId)) {
        issues.push(`计划字盘 ${p.caseCode} 已不再引用旧模，格位可能已变动`);
      }
    }

    for (const pc of batch.plan) {
      const c = await db.cases.get(pc.caseId);
      if (!c) {
        issues.push(`计划字盘 ${pc.caseCode} 档案不存在`);
        continue;
      }
      if ((c.version ?? 1) !== pc.caseVersion) {
        issues.push(`字盘 ${c.code} 版本已变动（草稿 v${pc.caseVersion} → 当前 v${c.version ?? 1}），请重新核对格位`);
        continue;
      }
      for (const slot of pc.slots) {
        const live = c.slots.find((s) => s.row === slot.row && s.col === slot.col);
        if (!live || live.matrixId !== slot.fromMatrixId) {
          issues.push(
            `字盘 ${c.code} 格位 ${String.fromCharCode(65 + slot.row)}${slot.col + 1} 已不是旧模落位，请重新核对`,
          );
        }
      }
    }
  }

  gate.caseIssues = issues;
  gate.caseChecked = issues.length === 0;
  return gate;
}

/** 依据当前字盘落位构造迁移计划 */
async function buildPlan(sourceMatrixId: string, successorMatrixId: string): Promise<RecarvePlanCase[]> {
  const cases = await db.cases.where('matrixId').equals(sourceMatrixId).toArray();
  const plan: RecarvePlanCase[] = [];
  for (const c of cases) {
    const slots: RecarvePlanSlot[] = c.slots
      .filter((s) => s.matrixId === sourceMatrixId)
      .map((s) => ({
        row: s.row,
        col: s.col,
        character: s.character,
        fromMatrixId: sourceMatrixId,
        toMatrixId: successorMatrixId,
      }));
    if (slots.length === 0) continue;
    plan.push({
      caseId: c.id,
      caseCode: c.code,
      caseVersion: c.version ?? 1,
      slots,
    });
  }
  return plan;
}

export const useRecarveStore = create<RecarveState>((set, get) => ({
  batches: [],
  loaded: false,
  loading: false,
  error: '',

  load: async () => {
    set({ loading: true, error: '' });
    try {
      await ensureSeed();
      const batches = await db.recarveBatches.toArray();
      set({ batches: batches.sort(byCreatedDesc), loaded: true, loading: false });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : '代际补刻档案读取失败' });
    }
  },

  createSuccessor: async (sourceMatrixId, operator) => {
    const source = await db.matrices.get(sourceMatrixId);
    if (!source) throw new Error('未找到待补刻字模');
    if (source.availability === '可用') {
      throw new Error('该字模当前可用，无需代际补刻');
    }
    // 同一旧模只允许有一份未完成批次
    const existed = await db.recarveBatches
      .where('sourceMatrixId')
      .equals(sourceMatrixId)
      .filter((b) => b.status !== 'migrated')
      .first();
    if (existed) return existed;

    const now = new Date().toISOString();
    const successorId = makeId('mtx');
    const generation = generationOf(source) + 1;
    const successor: TypeMatrix = toPlain({
      ...source,
      id: successorId,
      // 新模沿用旧编号：code / 字符 / 字体字号材质等全部继承，仅代际 +1
      generation,
      lineageId: source.lineageId || source.id,
      prevMatrixId: source.id,
      successorMatrixId: '',
      availability: '可用',
      note: `代际补刻接替模（沿用旧编号 ${source.code}，${generation - 1}代 → ${generation}代）`,
      createdAt: now,
      updatedAt: now,
    });

    const batchId = makeId('rcv');
    const plan = await buildPlan(source.id, successorId);
    const batch: RecarveBatch = {
      id: batchId,
      sourceMatrixId: source.id,
      successorMatrixId: successorId,
      lineageId: successor.lineageId,
      status: 'draft',
      plan,
      gate: emptyGate(),
      rejectReason: '',
      operator: operator.trim() || '补刻工',
      createdAt: now,
      updatedAt: now,
      confirmedAt: '',
    };

    // 旧模缺损收口记录（沿用最近一条缺损的类型与程度）
    const latestDefect = await db.defects
      .where('matrixId')
      .equals(source.id)
      .sortBy('createdAt')
      .then((ds) => ds[ds.length - 1]);
    const closure: DefectLog = toPlain({
      id: makeId('dft'),
      matrixId: source.id,
      character: source.character,
      matrixCode: source.code,
      defectType: latestDefect?.defectType ?? '变形',
      severity: latestDefect?.severity ?? '中',
      foundDate: now.slice(0, 10),
      handling: `代际补刻收口：已刻制接替模（沿用旧编号），试印合格后迁移格位，旧模退役留档`,
      availability: '停用',
      operator: batch.operator,
      note: `接替模 ${successor.code} ${generation}代`,
      closed: true,
      createdAt: now,
    });

    await db.transaction('rw', db.matrices, db.cases, db.defects, db.recarveBatches, async () => {
      await db.matrices.add(successor);
      await db.matrices.update(source.id, { successorMatrixId: successor.id, updatedAt: now });
      await db.defects.add(closure);
      await db.recarveBatches.add(batch);
    });

    const gate = await computeGate(batch);
    const withGate: RecarveBatch = { ...batch, gate, updatedAt: new Date().toISOString() };
    await db.recarveBatches.update(batchId, { gate: withGate.gate, updatedAt: withGate.updatedAt });

    set((s) => ({ batches: [withGate, ...s.batches.filter((b) => b.id !== batchId)].sort(byCreatedDesc) }));
    notifyRecarveChanged();
    return withGate;
  },

  refreshGate: async (batchId) => {
    const batch = await db.recarveBatches.get(batchId);
    if (!batch) throw new Error('未找到补刻批次');
    const gate = await computeGate(batch);
    const updatedAt = new Date().toISOString();
    await db.recarveBatches.update(batchId, { gate, updatedAt });
    set((s) => ({
      batches: s.batches.map((b) => (b.id === batchId ? { ...b, gate, updatedAt } : b)),
    }));
    notifyRecarveChanged();
    return gate;
  },

  confirmMigration: async (batchId) => {
    // 跨标签页互斥：同一时刻只有一个标签页能进入关键区
    return withRecarveLock(async () => {
      // 关键区内重新读库：两个标签页同时提交时，只有一份能读到 draft
      const batch = await db.recarveBatches.get(batchId);
      if (!batch) return { ok: false, reasons: ['补刻批次不存在'] };
      if (batch.status === 'migrated') {
        return { ok: false, reasons: ['该批次已完成迁移，其它标签页可能已先行确认'] };
      }

      const reasons: string[] = [];
      const source = await db.matrices.get(batch.sourceMatrixId);
      const successor = await db.matrices.get(batch.successorMatrixId);
      if (!source) reasons.push('旧模档案不存在或已被删除');
      if (!successor) {
        reasons.push('接替模档案不存在或已被删除');
      } else if (successor.availability !== '可用') {
        reasons.push(`接替模不可用（当前状态：${successor.availability}），请先处理接替模`);
      }

      const gate = await computeGate(batch);
      if (!gate.proofClear) reasons.push('接替模尚无清晰试印样张');
      if (!gate.defectClosed) reasons.push('旧模缺损尚未收口');
      if (!gate.caseChecked) reasons.push(...gate.caseIssues);

      if (reasons.length > 0) {
        const updatedAt = new Date().toISOString();
        await db.recarveBatches.update(batchId, {
          status: 'rejected',
          gate,
          rejectReason: reasons.join('；'),
          updatedAt,
        });
        set((s) => ({
          batches: s.batches.map((b) =>
            b.id === batchId ? { ...b, status: 'rejected', gate, rejectReason: reasons.join('；'), updatedAt } : b,
          ),
        }));
        notifyRecarveChanged();
        return { ok: false, reasons };
      }

      // 全部通过：事务内迁移格位 + 旧模退役 + 批次置为已迁移
      const now = new Date().toISOString();
      await db.transaction('rw', db.matrices, db.cases, db.recarveBatches, async () => {
        for (const pc of batch.plan) {
          const c = await db.cases.get(pc.caseId);
          if (!c) throw new Error(`计划字盘 ${pc.caseCode} 档案不存在`);
          const slotMap = new Map(pc.slots.map((s) => [`${s.row}-${s.col}`, s]));
          const nextSlots = c.slots.map((s) => {
            const planned = slotMap.get(`${s.row}-${s.col}`);
            if (planned && s.matrixId === planned.fromMatrixId) {
              return { ...s, matrixId: planned.toMatrixId, placedAt: now };
            }
            return s;
          });
          await db.cases.update(c.id, {
            slots: nextSlots,
            matrixId: matrixIdsOf(nextSlots),
            version: (c.version ?? 1) + 1,
            updatedAt: now,
          });
        }
        await db.matrices.update(batch.sourceMatrixId, {
          availability: '停用',
          successorMatrixId: batch.successorMatrixId,
          updatedAt: now,
        });
        await db.recarveBatches.update(batchId, {
          status: 'migrated',
          gate,
          rejectReason: '',
          updatedAt: now,
          confirmedAt: now,
        });
      });

      set((s) => ({
        batches: s.batches.map((b) =>
          b.id === batchId
            ? { ...b, status: 'migrated', gate, rejectReason: '', updatedAt: now, confirmedAt: now }
            : b,
        ),
      }));
      notifyRecarveChanged();
      return { ok: true, reasons: [] };
    });
  },

  retryBatch: async (batchId) => {
    const batch = await db.recarveBatches.get(batchId);
    if (!batch) return { ok: false, reasons: ['补刻批次不存在'] };
    if (batch.status === 'migrated') return { ok: true, reasons: [] };
    const updatedAt = new Date().toISOString();
    await db.recarveBatches.update(batchId, { status: 'draft', rejectReason: '', updatedAt });
    set((s) => ({
      batches: s.batches.map((b) =>
        b.id === batchId ? { ...b, status: 'draft', rejectReason: '', updatedAt } : b,
      ),
    }));
    return get().confirmMigration(batchId);
  },

  discardBatch: async (batchId) => {
    await db.recarveBatches.delete(batchId);
    set((s) => ({ batches: s.batches.filter((b) => b.id !== batchId) }));
    notifyRecarveChanged();
  },
}));

/** 跨标签页同步：其它标签页变动后重新拉取批次、字模与字盘 */
if (typeof window !== 'undefined') {
  let timer: number | undefined;
  subscribeRecarveChanged(() => {
    if (timer) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      void useRecarveStore.getState().load();
      // 字模 / 字盘状态也可能随迁移变化，一并刷新
      void useMatrixStore.getState().load();
      void useCaseStore.getState().load();
    }, 120);
  });
}
