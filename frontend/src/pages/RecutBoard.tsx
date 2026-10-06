import { useEffect, useMemo, useState, type FormEvent } from 'react';
import RecutJobCard from '../components/recut/RecutJobCard';
import EmptyState from '../components/common/EmptyState';
import { DRAFT_KEYS, useLocalDraft } from '../hooks/useLocalDraft';
import { useCaseStore } from '../stores/caseStore';
import { useMatrixStore } from '../stores/matrixStore';
import { useRecutStore, RecutBatchRejectedError } from '../stores/recutStore';
import { useUiStore } from '../stores/uiStore';
import { MADE_YEAR_RANGE, generationLabel } from '../types/matrix';
import type { RecutStatus } from '../types/recut';
import { RECUT_STATUSES } from '../types/recut';
import { todayStr } from '../utils/format';
import { checkRecutBatch } from '../utils/recut';

interface StartFormState {
  oldMatrixId: string;
  engraver: string;
  madeYear: string;
  reason: string;
  note: string;
}

interface BatchDraftState {
  jobIds: string[];
  operator: string;
  confirmed: boolean;
}

const TABS: Array<{ status: RecutStatus | 'all'; label: string }> = [
  { status: '待验收', label: '待验收' },
  { status: '待迁移', label: '待迁移' },
  { status: '已迁移', label: '已迁移' },
  { status: '已取消', label: '已取消' },
  { status: 'all', label: '全部' },
];

/** `/recuts` 代际补刻：建接替模 → 两关验收 → 核对格位后整批迁移 */
export default function RecutBoard() {
  const matrices = useMatrixStore((s) => s.matrices);
  const recuts = useRecutStore((s) => s.recuts);
  const loaded = useRecutStore((s) => s.loaded);
  const recutLoad = useRecutStore((s) => s.load);
  const startRecut = useRecutStore((s) => s.startRecut);
  const commitBatch = useRecutStore((s) => s.commitBatch);
  const cases = useCaseStore((s) => s.cases);
  const matrixLoad = useMatrixStore((s) => s.load);
  const caseLoad = useCaseStore((s) => s.load);
  const pushToast = useUiStore((s) => s.pushToast);

  const [tab, setTab] = useState<RecutStatus | 'all'>('待验收');
  const [submitting, setSubmitting] = useState(false);

  const eligibleOlds = useMemo(() => {
    const activeOlds = new Set(
      recuts.filter((j) => j.status === '待验收' || j.status === '待迁移').map((j) => j.oldMatrixId),
    );
    return matrices.filter(
      (m) => (m.availability === '待补刻' || m.availability === '停用') && !activeOlds.has(m.id) && !m.replacesId,
    );
  }, [matrices, recuts]);

  const { draft: startDraft, patch: patchStart, reset: resetStart } = useLocalDraft<StartFormState>(
    DRAFT_KEYS.recutStart,
    { oldMatrixId: '', engraver: '', madeYear: String(new Date().getFullYear()), reason: '', note: '' },
  );

  const {
    draft: batchDraft,
    patch: patchBatch,
    reset: resetBatch,
    existed: batchExisted,
  } = useLocalDraft<BatchDraftState>(DRAFT_KEYS.recutBatch, { jobIds: [], operator: '', confirmed: false });

  useEffect(() => {
    if (!startDraft.oldMatrixId && eligibleOlds.length > 0) {
      const first = eligibleOlds[0];
      patchStart({ oldMatrixId: first.id, engraver: first.engraver });
    }
  }, [startDraft.oldMatrixId, eligibleOlds, patchStart]);

  const selectedOld = matrices.find((m) => m.id === startDraft.oldMatrixId);

  const refreshAll = async () => {
    await Promise.all([recutLoad(), matrixLoad(), caseLoad()]);
  };

  const handleStart = async (e: FormEvent) => {
    e.preventDefault();
    if (!startDraft.oldMatrixId) {
      pushToast('请先选择一枚待补刻旧模', 'warn');
      return;
    }
    const year = Number(startDraft.madeYear);
    if (!Number.isInteger(year) || year < MADE_YEAR_RANGE.min || year > MADE_YEAR_RANGE.max) {
      pushToast(`补刻年代需在 ${MADE_YEAR_RANGE.min}–${MADE_YEAR_RANGE.max} 之间`, 'warn');
      return;
    }
    if (!startDraft.reason.trim()) {
      pushToast('请填写补刻原因', 'warn');
      return;
    }
    setSubmitting(true);
    try {
      const job = await startRecut({
        oldMatrixId: startDraft.oldMatrixId,
        engraver: startDraft.engraver,
        madeYear: year,
        reason: startDraft.reason,
        note: startDraft.note,
      });
      await refreshAll();
      resetStart();
      setTab('待验收');
      pushToast(`已为「${job.character}」刻好 ${generationLabel(job.successorGeneration)} 接替模（沿用编号 ${job.code}），请完成试印与缺损收口`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '建立接替模失败', 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const migratableJobs = useMemo(() => recuts.filter((j) => j.status === '待迁移'), [recuts]);

  // 用各 store 中的当前数据做提交前核对（事务内还会用最新数据再核对一遍）
  const precheck = useMemo(() => {
    const selected = migratableJobs.filter((j) => batchDraft.jobIds.includes(j.id));
    const byId = new Map(matrices.map((m) => [m.id, m]));
    return { selected, check: checkRecutBatch(selected, cases, byId) };
  }, [migratableJobs, batchDraft.jobIds, matrices, cases]);

  const toggleSelect = (jobId: string) => {
    const next = batchDraft.jobIds.includes(jobId)
      ? batchDraft.jobIds.filter((id) => id !== jobId)
      : [...batchDraft.jobIds, jobId];
    patchBatch({ jobIds: next });
  };

  const handleCommit = async () => {
    if (precheck.selected.length === 0) {
      pushToast('请勾选至少一个待迁移工程', 'warn');
      return;
    }
    if (!precheck.check.valid) {
      pushToast(`核对未通过，整批拒绝：${precheck.check.errors.map((i) => i.message).join('；')}`, 'error');
      return;
    }
    if (!batchDraft.confirmed) {
      pushToast('请先确认「格位将迁给接替模、旧模与旧样张保留」', 'warn');
      return;
    }
    setSubmitting(true);
    try {
      const result = await commitBatch(precheck.selected.map((j) => j.id), batchDraft.operator);
      if (!result) return;
      await refreshAll();
      resetBatch();
      setTab('已迁移');
      pushToast(`已完成 ${result.migrated.length} 个补刻工程的格位迁移，旧模已停用留存`);
    } catch (err) {
      if (err instanceof RecutBatchRejectedError) {
        await recutLoad();
        pushToast(`整批迁移被拒绝（草稿已保留，可重试）：${err.messages.join('；')}`, 'error');
      } else {
        pushToast(err instanceof Error ? err.message : '迁移失败', 'error');
      }
    } finally {
      setSubmitting(false);
    }
  };

  const visibleJobs = useMemo(
    () => (tab === 'all' ? recuts : recuts.filter((j) => j.status === tab)),
    [recuts, tab],
  );

  const countOf = (status: RecutStatus) => recuts.filter((j) => j.status === status).length;

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="mt-title" data-testid="recut-board-title">
            代际补刻
          </h2>
          <p className="mt-sub">
            待补刻旧模先另立沿用旧编号的接替模；清晰试印与缺损收口两关齐备后，核对字盘版本与格位，再把在盘格位整批迁过去。旧模、旧缺损与旧试印样张一律保留。
          </p>
        </div>
        <div className="flex flex-wrap gap-2" data-testid="recut-stats">
          <span className="mt-chip border-brass/40 text-brass" data-testid="recut-count-accept">
            待验收 {countOf('待验收')}
          </span>
          <span className="mt-chip border-seal/40 text-seal" data-testid="recut-count-migrate">
            待迁移 {countOf('待迁移')}
          </span>
          <span className="mt-chip border-jade/40 text-jade" data-testid="recut-count-done">
            已迁移 {countOf('已迁移')}
          </span>
        </div>
      </section>

      <section className="mt-panel">
        <div className="mt-panel-head">
          <h3 className="font-song text-sm font-semibold text-ink">第一步 · 建立接替模</h3>
          <span className="mt-sub" data-testid="recut-draft-status">
            表单草稿自动保存，关页再开可继续
          </span>
        </div>
        <form className="grid grid-cols-1 gap-3 px-4 py-4 md:grid-cols-4" onSubmit={handleStart} data-testid="recut-start-form">
          <div className="md:col-span-2">
            <label className="mt-label" htmlFor="recut-old-select">
              待补刻旧模
            </label>
            <select
              id="recut-old-select"
              data-testid="recut-old-select"
              className="mt-input"
              value={startDraft.oldMatrixId}
              onChange={(e) => {
                const m = matrices.find((x) => x.id === e.target.value);
                patchStart({ oldMatrixId: e.target.value, engraver: m?.engraver ?? startDraft.engraver });
              }}
            >
              <option value="">请选择旧模</option>
              {eligibleOlds.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.character} · {m.code}（{generationLabel(m.generation ?? 1)}）· {m.availability} · {m.font}/{m.sizeName}
                </option>
              ))}
            </select>
            {eligibleOlds.length === 0 ? <p className="mt-hint">当前没有可补刻的旧模（已有进行中工程的不重复建立）。</p> : null}
          </div>
          <div>
            <label className="mt-label" htmlFor="recut-engraver">
              补刻刻工
            </label>
            <input
              id="recut-engraver"
              data-testid="recut-engraver"
              className="mt-input"
              value={startDraft.engraver}
              onChange={(e) => patchStart({ engraver: e.target.value })}
              placeholder="例：周介庵"
            />
          </div>
          <div>
            <label className="mt-label" htmlFor="recut-year">
              补刻年代
            </label>
            <input
              id="recut-year"
              data-testid="recut-year"
              className="mt-input"
              type="number"
              min={MADE_YEAR_RANGE.min}
              max={MADE_YEAR_RANGE.max}
              value={startDraft.madeYear}
              onChange={(e) => patchStart({ madeYear: e.target.value })}
            />
          </div>
          <div className="md:col-span-3">
            <label className="mt-label" htmlFor="recut-reason">
              补刻原因
            </label>
            <input
              id="recut-reason"
              data-testid="recut-reason"
              className="mt-input"
              value={startDraft.reason}
              onChange={(e) => patchStart({ reason: e.target.value })}
              placeholder="例：木活字受潮翘曲，按补刻师傅要求沿用旧编号重刻二代"
            />
          </div>
          <div>
            <label className="mt-label" htmlFor="recut-note">
              接替模备注
            </label>
            <input
              id="recut-note"
              data-testid="recut-note"
              className="mt-input"
              value={startDraft.note}
              onChange={(e) => patchStart({ note: e.target.value })}
            />
          </div>
          <div className="md:col-span-4 flex flex-wrap items-center gap-2">
            <button type="submit" className="mt-btn mt-btn-primary" disabled={submitting} data-testid="recut-start-submit">
              {submitting ? '建立中…' : '建立接替模（沿用旧编号）'}
            </button>
            <button
              type="button"
              className="mt-btn"
              onClick={() => {
                resetStart();
                pushToast('已清空补刻表单草稿', 'warn');
              }}
            >
              清空草稿
            </button>
            {selectedOld ? (
              <span className="mt-hint" data-testid="recut-preview">
                将生成编号 {selectedOld.code} 的 {generationLabel((selectedOld.generation ?? 1) + 1)} 新实体，初置「验收中」
              </span>
            ) : null}
          </div>
        </form>
      </section>

      <section className="mt-panel">
        <div className="mt-panel-head">
          <div className="flex flex-wrap items-center gap-1" role="tablist" data-testid="recut-tabs">
            {TABS.map((t) => (
              <button
                key={t.status}
                type="button"
                role="tab"
                aria-selected={tab === t.status}
                data-testid={`recut-tab-${t.status}`}
                onClick={() => setTab(t.status)}
                className={`rounded border px-3 py-1 text-xs transition ${
                  tab === t.status
                    ? 'border-seal bg-seal text-paper'
                    : 'border-paper-line bg-white text-ink-soft hover:border-seal'
                }`}
              >
                {t.label}
                {t.status !== 'all' ? ` ${countOf(t.status)}` : ` ${recuts.length}`}
              </button>
            ))}
          </div>
        </div>

        {visibleJobs.length === 0 ? (
          <div className="px-4 py-6">
            <EmptyState
              title={loaded ? '当前分类下没有补刻工程' : '正在读取补刻档案…'}
              description={
                loaded
                  ? tab === '待验收'
                    ? '在上方选择一枚待补刻旧模，建立沿用旧编号的接替模后在此验收。'
                    : '可切换其他分类查看。'
                  : '首次进入会写入示例档案，请稍候。'
              }
              testId="recut-empty"
            />
          </div>
        ) : (
          <ul className="space-y-3 px-4 py-4" data-testid="recut-job-list">
            {visibleJobs.map((job) => (
              <RecutJobCard
                key={job.id}
                job={job}
                selected={batchDraft.jobIds.includes(job.id)}
                onToggleSelect={toggleSelect}
                onChanged={refreshAll}
              />
            ))}
          </ul>
        )}
      </section>

      {migratableJobs.length > 0 ? (
        <section className="sticky bottom-3 z-10 mt-panel" data-testid="recut-batch-bar">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <div className="space-y-1">
              <h3 className="font-song text-sm font-semibold text-ink">
                第三步 · 整批迁移格位（已选 {precheck.selected.length} / 待迁移 {migratableJobs.length}）
              </h3>
              <div className="flex flex-wrap items-center gap-2 text-[11px]">
                <input
                  className="mt-input max-w-[180px]"
                  placeholder="迁移操作人"
                  value={batchDraft.operator}
                  onChange={(e) => patchBatch({ operator: e.target.value })}
                  data-testid="recut-batch-operator"
                />
                <label className="flex items-center gap-1 text-ink-soft">
                  <input
                    type="checkbox"
                    checked={batchDraft.confirmed}
                    onChange={(e) => patchBatch({ confirmed: e.target.checked })}
                    data-testid="recut-batch-confirm"
                  />
                  格位迁给接替模，旧模与旧样张保留
                </label>
                {batchExisted ? <span className="text-brass">已恢复上次迁移草稿</span> : null}
              </div>
              <ul className="text-[11px]" data-testid="recut-precheck">
                {precheck.check.warnings.map((w) => (
                  <li key={`${w.jobId}-${w.message}`} className="text-brass">
                    提示：{w.message}
                  </li>
                ))}
                {precheck.check.errors.map((w) => (
                  <li key={`${w.jobId}-${w.message}`} className="text-seal" data-testid="recut-precheck-error">
                    阻断：{w.message}
                  </li>
                ))}
                {precheck.check.valid && precheck.selected.length > 0 ? (
                  <li className="text-jade">核对通过：字盘版本与格位归属一致，接替模均可用。</li>
                ) : null}
              </ul>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="mt-btn mt-btn-primary"
                disabled={submitting}
                data-testid="recut-batch-submit"
                onClick={handleCommit}
              >
                {submitting ? '迁移中…' : '确认整批迁移'}
              </button>
              <button
                type="button"
                className="mt-btn"
                disabled={submitting}
                data-testid="recut-batch-clear"
                onClick={() => {
                  resetBatch();
                  pushToast('已清空迁移勾选草稿', 'warn');
                }}
              >
                清空勾选
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <p className="text-[11px] text-ink-mute">
        迁移在单个 IndexedDB 事务内完成并复核字盘版本：两个标签页同时提交时只有一份能生效；任一格位仍被别盘引用或接替模不可用，整批拒绝且不动任何数据，失败后草稿保留可重试。今天是 {todayStr()}。
      </p>
    </div>
  );
}
