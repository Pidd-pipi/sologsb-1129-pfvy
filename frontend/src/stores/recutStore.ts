import { create } from 'zustand';
import { db, ensureSeed } from '../db';
import type { DefectLog } from '../types/defect';
import { shouldDisableMatrix } from '../types/defect';
import type { TypeMatrix } from '../types/matrix';
import type { ProofRecord } from '../types/proof';
import type {
  ClearProofInput,
  CloseDefectInput,
  RecutJob,
  RecutStatus,
  StartRecutInput,
} from '../types/recut';
import { RECUT_ACTIVE_STATUSES } from '../types/recut';
import { makeId, toPlain, todayStr } from '../utils/format';
import { checkRecutBatch, evaluateRecutGate, scanPlanSlots, type RecutBatchIssue } from '../utils/recut';
import { withMigrationLock } from '../utils/migrationLock';

export class RecutBatchRejectedError extends Error {
  messages: string[];
  jobs: RecutJob[];
  issues: RecutBatchIssue[];
  constructor(messages: string[], jobs: RecutJob[] = [], issues: RecutBatchIssue[] = []) {
    super(messages.join('；'));
    this.name = 'RecutBatchRejectedError';
    this.messages = messages;
    this.jobs = jobs;
    this.issues = issues;
  }
}

interface RecutState {
  recuts: RecutJob[];
  loaded: boolean;
  loading: boolean;
  error: string;
  load: () => Promise<void>;
  /** 建立接替模（沿用旧编号的新一代实体），工程进入「待验收」 */
  startRecut: (input: StartRecutInput) => Promise<RecutJob>;
  /** 接替模登记清晰试印；两关齐备时自动推进到「待迁移」 */
  addSuccessorProof: (input: ClearProofInput) => Promise<void>;
  /** 接替模缺损收口（登记一条「可用」结论）；两关齐备时自动推进 */
  closeSuccessorDefect: (input: CloseDefectInput) => Promise<void>;
  /** 重新核对并刷新待迁移格位计划与字盘版本快照 */
  rescanPlan: (jobId: string) => Promise<RecutJob>;
  /** 取消补刻：接替模停用，工程归档为「已取消」 */
  cancelRecut: (jobId: string, operator: string) => Promise<void>;
  /**
   * 整批迁移：跨标签页锁 + 单事务内重新核对版本与格位，
   * 任一致命问题整批拒绝（事务回滚、草稿保留可重试）。
   * 返回 null 表示别的标签页正在迁移。
   */
  commitBatch: (jobIds: string[], operator: string) => Promise<{ migrated: RecutJob[] } | null>;
}

export const useRecutStore = create<RecutState>((set, get) => ({
  recuts: [],
  loaded: false,
  loading: false,
  error: '',

  load: async () => {
    set({ loading: true, error: '' });
    try {
      await ensureSeed();
      const recuts = await db.recuts.toArray();
      set({
        recuts: recuts.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
        loaded: true,
        loading: false,
      });
    } catch (err) {
      set({ loading: false, error: err instanceof Error ? err.message : '补刻档案读取失败' });
    }
  },

  startRecut: async (input) => {
    const now = new Date().toISOString();
    const old = await db.matrices.get(input.oldMatrixId);
    if (!old) throw new Error('未找到待补刻旧模');
    if (old.replacesId) throw new Error('该字模本身已是接替模，请在其初代谱系上操作');

    const exists = await db.recuts
      .where('oldMatrixId')
      .equals(old.id)
      .filter((j) => RECUT_ACTIVE_STATUSES.includes(j.status))
      .first();
    if (exists) throw new Error('这枚旧模已有进行中的补刻工程，请在补刻页继续验收或迁移');

    const successorId = makeId('mtx');
    const successor: TypeMatrix = toPlain({
      ...old,
      id: successorId,
      code: old.code, // 补刻师傅要求：新模沿用旧编号
      madeYear: Number(input.madeYear),
      engraver: input.engraver.trim() || old.engraver,
      note: (input.note ?? '').trim(),
      availability: '验收中' as const,
      generation: (old.generation ?? 1) + 1,
      lineageId: old.lineageId || old.id,
      replacesId: old.id,
      createdAt: now,
      updatedAt: now,
    });

    const liveCases = await db.cases.toArray();
    const { planSlots, caseVersions } = scanPlanSlots(old.id, liveCases);

    const job: RecutJob = toPlain({
      id: makeId('rct'),
      oldMatrixId: old.id,
      successorMatrixId: successorId,
      code: old.code,
      character: old.character,
      successorGeneration: successor.generation,
      status: '待验收' as RecutStatus,
      engraver: successor.engraver,
      reason: input.reason.trim(),
      planSlots,
      caseVersions,
      lastError: '',
      createdAt: now,
      updatedAt: now,
      migratedAt: '',
      canceledAt: '',
    });

    await db.transaction('rw', db.matrices, db.recuts, async () => {
      await db.matrices.add(successor);
      await db.recuts.add(job);
    });
    set((s) => ({ recuts: [job, ...s.recuts] }));
    return job;
  },

  addSuccessorProof: async (input) => {
    const job = get().recuts.find((j) => j.id === input.jobId);
    if (!job) throw new Error('未找到补刻工程');
    if (job.status !== '待验收') throw new Error(`工程当前为「${job.status}」，不能再登记验收试印`);

    const successor = await db.matrices.get(job.successorMatrixId);
    if (!successor) throw new Error('未找到接替模');

    const proof: ProofRecord = toPlain({
      id: makeId('pfr'),
      targetKind: '字符' as const,
      targetRef: successor.character,
      matrixId: successor.id,
      pressureKg: Number(input.pressureKg),
      ink: input.ink.trim(),
      impressions: Number(input.impressions),
      sampleNo: input.sampleNo.trim(),
      clarity: '清晰' as const,
      proofDate: input.proofDate || todayStr(),
      note: (input.note ?? '代际补刻：接替模清晰试印').trim(),
      createdAt: new Date().toISOString(),
    });
    await db.proofs.add(proof);
    await advanceIfReady(job.id);
  },

  closeSuccessorDefect: async (input) => {
    const job = get().recuts.find((j) => j.id === input.jobId);
    if (!job) throw new Error('未找到补刻工程');
    if (job.status !== '待验收') throw new Error(`工程当前为「${job.status}」，缺损已收口`);

    const successor = await db.matrices.get(job.successorMatrixId);
    if (!successor) throw new Error('未找到接替模');

    const now = new Date().toISOString();
    const operator = input.operator.trim() || '补刻工';

    await db.transaction('rw', db.defects, async () => {
      // 把接替模此前结论为停用 / 待补刻的缺损记录逐条收口为「可用」（实体保留）
      const openDefects = await db.defects
        .where('matrixId')
        .equals(successor.id)
        .filter((d) => shouldDisableMatrix(d.availability))
        .toArray();
      for (const d of openDefects) {
        await db.defects.update(d.id, {
          availability: '可用' as const,
          handling: `${d.handling}｜代际补刻复测合格，缺损收口`,
        });
      }

      // 再留一条收口记录（没有历史缺损时也保证有据可查）
      const row: DefectLog = toPlain({
        id: makeId('dft'),
        matrixId: successor.id,
        character: successor.character,
        matrixCode: successor.code,
        defectType: '磨损' as const,
        severity: '轻' as const,
        foundDate: todayStr(),
        handling: '代际补刻接替模缺损收口：复测合格，准予进入格位迁移',
        availability: '可用' as const,
        operator,
        note: (input.note ?? '缺损收口记录').trim(),
        createdAt: now,
      });
      await db.defects.add(row);
    });
    await advanceIfReady(job.id);
  },

  rescanPlan: async (jobId) => {
    const job = get().recuts.find((j) => j.id === jobId);
    if (!job) throw new Error('未找到补刻工程');
    const liveCases = await db.cases.toArray();
    const { planSlots, caseVersions } = scanPlanSlots(job.oldMatrixId, liveCases);
    const next: Partial<RecutJob> = {
      planSlots: toPlain(planSlots),
      caseVersions: toPlain(caseVersions),
      lastError: '',
      updatedAt: new Date().toISOString(),
    };
    await db.recuts.update(jobId, next);
    const updated = { ...job, ...next };
    set((s) => ({ recuts: s.recuts.map((j) => (j.id === jobId ? updated : j)) }));
    return updated;
  },

  cancelRecut: async (jobId, operator) => {
    const job = get().recuts.find((j) => j.id === jobId);
    if (!job) throw new Error('未找到补刻工程');
    if (!RECUT_ACTIVE_STATUSES.includes(job.status)) {
      throw new Error(`工程已${job.status}，不能取消`);
    }
    const now = new Date().toISOString();
    await db.transaction('rw', db.matrices, db.recuts, async () => {
      await db.matrices.update(job.successorMatrixId, {
        availability: '停用',
        note: `补刻工程取消，接替模停用归档（操作人：${operator.trim() || '补刻工'}）`,
        updatedAt: now,
      });
      await db.recuts.update(jobId, { status: '已取消', canceledAt: now, updatedAt: now });
    });
    set((s) => ({
      recuts: s.recuts.map((j) =>
        j.id === jobId ? { ...j, status: '已取消', canceledAt: now, updatedAt: now } : j,
      ),
    }));
  },

  commitBatch: async (jobIds, operator) => {
    if (jobIds.length === 0) throw new Error('请先勾选要迁移的补刻工程');

    const out = await withMigrationLock(async () => {
      const now = new Date().toISOString();
      const op = operator.trim() || '补刻工';

      // 事务内读取最新数据并再次核对：两个标签页同时提交时，后到者会看到版本已变
      try {
        return await db.transaction(
          'rw',
          db.cases,
          db.matrices,
          db.defects,
          db.recuts,
          async () => {
            const jobs = await db.recuts.where('id').anyOf(jobIds).toArray();
            const liveCases = await db.cases.toArray();
            const liveMatrices = await db.matrices.toArray();
            const matricesById = new Map(liveMatrices.map((m) => [m.id, m]));

            const check = checkRecutBatch(jobs, liveCases, matricesById);
            if (!check.valid) {
              throw new RecutBatchRejectedError(check.errors.map((i) => i.message), jobs, check.errors);
            }

            const migratedJobs: RecutJob[] = [];

            // 每个字盘在本批中只写一次：聚合所有涉及该字盘的工程后统一 CAS 落库
            const caseWrites = new Map<
              string,
              { expectedVersion: number; replacements: Map<string, { successor: TypeMatrix }> }
            >();
            for (const job of jobs) {
              const successor = matricesById.get(job.successorMatrixId)!;
              for (const slot of job.planSlots) {
                let w = caseWrites.get(slot.caseId);
                if (!w) {
                  w = { expectedVersion: job.caseVersions[slot.caseId], replacements: new Map() };
                  caseWrites.set(slot.caseId, w);
                }
                w.replacements.set(`${slot.row}-${slot.col}`, { successor });
              }
            }

            for (const [caseId, w] of caseWrites) {
              const typeCase = liveCases.find((c) => c.id === caseId)!;
              const slots = typeCase.slots.map((s) => {
                const rep = w.replacements.get(`${s.row}-${s.col}`);
                return rep
                  ? {
                      ...s,
                      matrixId: rep.successor.id,
                      matrixGen: rep.successor.generation,
                      character: rep.successor.character,
                      placedAt: now,
                    }
                  : s;
              });
              const ids = Array.from(new Set(slots.map((s) => s.matrixId).filter(Boolean)));
              const nextVersion = w.expectedVersion + 1;
              // 条件更新（compare-and-set）：只在版本仍等于快照时落库
              let changed = 0;
              await db.cases
                .where('id')
                .equals(caseId)
                .modify((c) => {
                  if (c.version !== w.expectedVersion) return;
                  c.slots = slots;
                  c.matrixId = ids;
                  c.version = nextVersion;
                  c.updatedAt = now;
                  changed += 1;
                });
              // 更新 0 行说明已被并发事务（另一个标签页）抢先推进，整批回滚
              if (changed === 0) {
                const latest = await db.cases.get(caseId);
                const message = `字盘 ${latest?.code ?? caseId} 版本已被另一标签页改动（期望 v${w.expectedVersion}，当前 v${latest?.version ?? '?'}），本批拒绝迁移`;
                throw new RecutBatchRejectedError(
                  [message],
                  jobs,
                  jobs.map((j) => ({ jobId: j.id, severity: 'error' as const, message })),
                );
              }
              // 同步事务内的本地缓存，保证同批多个工程落同一字盘时版本连续
              typeCase.slots = slots;
              typeCase.matrixId = ids;
              typeCase.version = nextVersion;
              for (const job of jobs) job.caseVersions[caseId] = nextVersion;
            }

            for (const job of jobs) {
              // 旧模转停用、保留实体；旧缺损与旧试印样张原样留存，不做改挂
              await db.matrices.update(job.oldMatrixId, {
                availability: '停用' as const,
                updatedAt: now,
              });

              const closure: DefectLog = toPlain({
                id: makeId('dft'),
                matrixId: job.oldMatrixId,
                character: job.character,
                matrixCode: job.code,
                defectType: '磨损' as const,
                severity: '轻' as const,
                foundDate: todayStr(),
                handling: `代际补刻收口：格位已迁至${job.successorGeneration} 代接替模（${job.successorMatrixId}），旧模停用留存`,
                availability: '停用' as const,
                operator: op,
                note: '旧模与旧样张保留备查',
                createdAt: now,
              });
              await db.defects.add(closure);

              await db.recuts.update(job.id, {
                status: '已迁移' as RecutStatus,
                lastError: '',
                caseVersions: job.caseVersions,
                migratedAt: now,
                updatedAt: now,
              });
              migratedJobs.push({ ...job, status: '已迁移', lastError: '', migratedAt: now, updatedAt: now });
            }

            return { migrated: migratedJobs };
          },
        );
      } catch (err) {
        // 迁移事务已整批回滚；在事务之外把失败原因写回工程，重开页面仍可见、可重试
        if (err instanceof RecutBatchRejectedError) {
          const stamp = new Date().toISOString();
          await db.transaction('rw', db.recuts, async () => {
            for (const job of err.jobs) {
              const own = err.issues.filter((i) => i.jobId === job.id).map((i) => i.message);
              if (own.length > 0) {
                await db.recuts.update(job.id, { lastError: own.join('；'), updatedAt: stamp });
              }
            }
          });
        }
        throw err;
      }
    });

    if (!out) {
      const busy = new Error('另一个标签页正在执行格位迁移，请稍候再提交');
      throw busy;
    }

    // 迁移成功：刷新各 store 的内存缓存（调用方负责触发，这里直接重载本 store）
    set((s) => ({
      recuts: s.recuts
        .map((j) => out.migrated.find((m) => m.id === j.id) ?? j)
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1)),
    }));
    return { migrated: out.migrated };
  },
}));

/**
 * 两关齐备后推进工程：接替模转「可用」，工程进入「待迁移」。
 * 在已写入试印 / 缺损收口记录之后调用，读取最新数据核对。
 */
async function advanceIfReady(jobId: string): Promise<void> {
  const state = useRecutStore.getState();
  const job = state.recuts.find((j) => j.id === jobId);
  if (!job || job.status !== '待验收') return;

  const [successor, proofs, defects] = await Promise.all([
    db.matrices.get(job.successorMatrixId),
    db.proofs.where('matrixId').equals(job.successorMatrixId).toArray(),
    db.defects.where('matrixId').equals(job.successorMatrixId).toArray(),
  ]);
  const gate = evaluateRecutGate(successor, proofs, defects);
  if (!gate.ready) return;

  const now = new Date().toISOString();
  // 进入待迁移前按字盘实况重扫一次，保证格位计划是最新的
  const liveCases = await db.cases.toArray();
  const { planSlots, caseVersions } = scanPlanSlots(job.oldMatrixId, liveCases);

  await db.transaction('rw', db.matrices, db.recuts, async () => {
    if (successor && successor.availability === '验收中') {
      await db.matrices.update(successor.id, { availability: '可用', updatedAt: now });
    }
    await db.recuts.update(jobId, {
      status: '待迁移',
      planSlots: toPlain(planSlots),
      caseVersions: toPlain(caseVersions),
      lastError: '',
      updatedAt: now,
    });
  });

  useRecutStore.setState((s) => ({
    recuts: s.recuts.map((j) =>
      j.id === jobId
        ? {
            ...j,
            status: '待迁移',
            planSlots: toPlain(planSlots),
            caseVersions: toPlain(caseVersions),
            lastError: '',
            updatedAt: now,
          }
        : j,
    ),
  }));
}

/** 取单条补刻工程（组件内按需订阅） */
export function selectRecut(id: string) {
  return (s: RecutState) => s.recuts.find((j) => j.id === id);
}
