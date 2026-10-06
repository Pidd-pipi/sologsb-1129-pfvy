import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import EmptyState from '../components/common/EmptyState';
import { useRecarveStore } from '../stores/recarveStore';
import { useMatrixStore } from '../stores/matrixStore';
import { useCaseStore } from '../stores/caseStore';
import { useUiStore } from '../stores/uiStore';
import { generationLabel } from '../types/matrix';
import {
  CLARITY_LEVELS,
  IMPRESSION_RANGE,
  PRESSURE_RANGE,
  type ClarityLevel,
  type ProofInput,
} from '../types/proof';
import { batchStatusLabel, type RecarveBatch } from '../types/recarve';
import { formatStamp, suggestSampleNo, todayStr } from '../utils/format';

/** `/recarves` 代际补刻：待补刻字模先建立接替模，清晰试印 + 缺损收口后再迁移格位 */
export default function RecarveBoard() {
  const matrices = useMatrixStore((s) => s.matrices);
  const defects = useMatrixStore((s) => s.defects);
  const proofs = useMatrixStore((s) => s.proofs);
  const addProof = useMatrixStore((s) => s.addProof);
  const cases = useCaseStore((s) => s.cases);
  const batches = useRecarveStore((s) => s.batches);
  const loaded = useRecarveStore((s) => s.loaded);
  const load = useRecarveStore((s) => s.load);
  const createSuccessor = useRecarveStore((s) => s.createSuccessor);
  const refreshGate = useRecarveStore((s) => s.refreshGate);
  const confirmMigration = useRecarveStore((s) => s.confirmMigration);
  const retryBatch = useRecarveStore((s) => s.retryBatch);
  const discardBatch = useRecarveStore((s) => s.discardBatch);
  const pushToast = useUiStore((s) => s.pushToast);

  const [busyId, setBusyId] = useState('');

  useEffect(() => {
    void load();
  }, [load]);

  /** 代际补刻会改动字模 / 字盘档案，操作后一并刷新各 store */
  const refreshAll = useCallback(() => {
    void load();
    void useMatrixStore.getState().load();
    void useCaseStore.getState().load();
  }, [load]);

  const pendingMatrices = useMemo(
    () => matrices.filter((m) => m.availability === '待补刻' || m.availability === '停用'),
    [matrices],
  );

  const batchBySource = useMemo(() => {
    const map = new Map<string, RecarveBatch>();
    for (const b of batches) {
      if (b.status !== 'migrated' && !map.has(b.sourceMatrixId)) map.set(b.sourceMatrixId, b);
    }
    return map;
  }, [batches]);

  const matrixOf = (id: string) => matrices.find((m) => m.id === id);
  const caseOf = (id: string) => cases.find((c) => c.id === id);
  const defectsOf = (id: string) =>
    defects
      .filter((d) => d.matrixId === id)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  const proofsOf = (id: string) =>
    proofs
      .filter((p) => p.matrixId === id)
      .sort((a, b) => (a.proofDate < b.proofDate ? 1 : -1));

  const handleCreate = async (sourceId: string) => {
    setBusyId(sourceId);
    try {
      const batch = await createSuccessor(sourceId, '补刻工 陈之安');
      refreshAll();
      const source = matrixOf(batch.sourceMatrixId);
      pushToast(
        `已为「${source?.character ?? ''}」建立接替模（沿用旧编号，${generationLabel(
          (source?.generation ?? 1) + 1,
        )}），请登记清晰试印并核对格位`,
      );
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '建立接替模失败', 'error');
    } finally {
      setBusyId('');
    }
  };

  const handleProof = async (batch: RecarveBatch, input: ProofInput) => {
    setBusyId(batch.id);
    try {
      await addProof(input);
      await refreshGate(batch.id);
      pushToast(`已登记试印样张 ${input.sampleNo}`);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '试印登记失败', 'error');
    } finally {
      setBusyId('');
    }
  };

  const handleRefresh = async (batchId: string) => {
    setBusyId(batchId);
    try {
      await refreshGate(batchId);
      pushToast('已按当前档案重新核对收口条件');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '核对失败', 'error');
    } finally {
      setBusyId('');
    }
  };

  const handleConfirm = async (batchId: string) => {
    setBusyId(batchId);
    try {
      const result = await confirmMigration(batchId);
      refreshAll();
      if (result.ok) {
        pushToast('迁移完成：在盘格位已迁到接替模，旧模退役留档');
      } else {
        pushToast(`整批拒绝：${result.reasons[0] ?? '条件未齐备'}`, 'error');
      }
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '迁移失败', 'error');
    } finally {
      setBusyId('');
    }
  };

  const handleRetry = async (batchId: string) => {
    setBusyId(batchId);
    try {
      const result = await retryBatch(batchId);
      refreshAll();
      if (result.ok) pushToast('重试成功：格位已迁移到接替模');
      else pushToast(`仍未通过：${result.reasons[0] ?? '条件未齐备'}`, 'error');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '重试失败', 'error');
    } finally {
      setBusyId('');
    }
  };

  const handleDiscard = async (batchId: string) => {
    setBusyId(batchId);
    try {
      await discardBatch(batchId);
      refreshAll();
      pushToast('已放弃该补刻草稿（接替模与旧档案保留）', 'warn');
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '放弃失败', 'error');
    } finally {
      setBusyId('');
    }
  };

  return (
    <div className="space-y-4">
      <section className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="mt-title" data-testid="recarve-title">
            代际补刻
          </h2>
          <p className="mt-sub">
            待补刻字模先建立接替模（新模沿用旧编号、代际 +1），清晰试印与缺损收口后再把在盘格位迁过去；
            旧模与旧样张保留，迁移前核对字盘版本与格位。
          </p>
        </div>
        <span className="mt-chip" data-testid="recarve-batch-count">
          补刻批次 {batches.length}
        </span>
      </section>

      <section className="mt-panel">
        <div className="mt-panel-head">
          <h3 className="font-song text-sm font-semibold text-ink">待补刻字模</h3>
          <span className="mt-sub">建立接替模后进入下方批次流程</span>
        </div>
        {pendingMatrices.length === 0 ? (
          <div className="px-4 py-4">
            <EmptyState title="没有待补刻字模" description="所有字模均处于可用状态。" testId="recarve-pending-empty" />
          </div>
        ) : (
          <ul className="divide-y divide-paper-line" data-testid="recarve-pending-list">
            {pendingMatrices.map((m) => {
              const open = batchBySource.get(m.id);
              const d = defectsOf(m.id)[0];
              return (
                <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-song text-lg text-ink">{m.character}</span>
                      <span className="text-[11px] text-ink-mute">{m.code}</span>
                      <span className="mt-chip">{generationLabel(m.generation)}</span>
                      <span className="mt-chip">{m.availability}</span>
                    </div>
                    {d ? <p className="text-[11px] text-ink-soft">{d.handling}</p> : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Link className="mt-btn" to={`/matrices/${m.id}`} data-testid={`recarve-detail-${m.id}`}>
                      查看详情
                    </Link>
                    {open ? (
                      <Link className="mt-btn mt-btn-primary" to={`#batch-${open.id}`} data-testid={`recarve-continue-${m.id}`}>
                        继续代际补刻
                      </Link>
                    ) : (
                      <button
                        type="button"
                        className="mt-btn mt-btn-primary"
                        data-testid={`recarve-create-${m.id}`}
                        disabled={busyId === m.id}
                        onClick={() => handleCreate(m.id)}
                      >
                        {busyId === m.id ? '建立中…' : '建立接替模'}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-3" data-testid="recarve-batch-list">
        {!loaded ? (
          <div className="mt-panel px-4 py-6 text-sm text-ink-mute">正在读取补刻批次…</div>
        ) : batches.length === 0 ? (
          <div className="mt-panel px-4 py-4">
            <EmptyState
              title="暂无代际补刻批次"
              description="在上方为待补刻字模建立接替模后，批次会出现在这里；草稿保存在本机，关页再开仍可继续。"
              testId="recarve-batch-empty"
            />
          </div>
        ) : (
          batches.map((b) => {
            const source = matrixOf(b.sourceMatrixId);
            const successor = matrixOf(b.successorMatrixId);
            return (
              <div key={b.id} id={`batch-${b.id}`} className="mt-panel scroll-mt-24" data-testid={`recarve-batch-${b.id}`}>
                <div className="mt-panel-head">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-song text-sm font-semibold text-ink">
                      {source?.character ?? '?'} · {source?.code ?? '—'}
                    </span>
                    <span className="text-ink-mute">→</span>
                    <span className="font-song text-sm font-semibold text-seal">
                      {successor?.character ?? '?'} · {successor?.code ?? '—'}
                    </span>
                    <span className="mt-chip">{generationLabel(source?.generation ?? 1)}</span>
                    <span className="text-ink-mute">→</span>
                    <span className="mt-chip border-seal/40 text-seal">{generationLabel(successor?.generation ?? 2)}</span>
                    <span
                      className={`mt-chip ${
                        b.status === 'migrated'
                          ? 'border-jade/40 text-jade'
                          : b.status === 'rejected'
                            ? 'border-seal/40 text-seal'
                            : 'border-brass/40 text-brass'
                      }`}
                      data-testid={`batch-status-${b.id}`}
                    >
                      {batchStatusLabel(b.status)}
                    </span>
                  </div>
                  <span className="mt-sub">
                    建立于 {formatStamp(b.createdAt)}
                    {b.confirmedAt ? ` · 迁移于 ${formatStamp(b.confirmedAt)}` : ''}
                  </span>
                </div>

                <div className="space-y-3 px-4 py-3">
                  {/* 迁移计划 */}
                  <div>
                    <h4 className="mb-1 font-song text-xs font-semibold text-ink">在盘格位迁移计划</h4>
                    {b.plan.length === 0 ? (
                      <p className="text-[11px] text-ink-mute">
                        旧模当前未落在任何字盘，迁移计划为空；接替模可直接使用，无需迁格。
                      </p>
                    ) : (
                      <ul className="space-y-1 text-[11px] text-ink-soft">
                        {b.plan.map((pc) => {
                          const c = caseOf(pc.caseId);
                          return (
                            <li key={pc.caseId} className="flex flex-wrap items-center gap-2">
                              <span className="mt-chip">
                                {pc.caseCode}
                                {c ? `（${c.kind} · ${c.workStation}）` : '（档案已删除）'}
                              </span>
                              <span>
                                {pc.slots
                                  .map((s) => `${String.fromCharCode(65 + s.row)}${s.col + 1}`)
                                  .join('、')}
                              </span>
                              <span className="text-ink-mute">
                                v{pc.caseVersion} → 接替模 {successor?.code ?? ''}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </div>

                  {/* 收口条件 */}
                  <div className="grid grid-cols-1 gap-2 md:grid-cols-3" data-testid={`batch-gate-${b.id}`}>
                    <GateItem
                      pass={b.gate.proofClear}
                      label="清晰试印"
                      detail={b.gate.proofClear ? `样张 ${b.gate.proofSampleNo}` : '接替模尚无清晰试印样张'}
                    />
                    <GateItem
                      pass={b.gate.defectClosed}
                      label="缺损收口"
                      detail={b.gate.defectClosed ? '旧模缺损已收口' : '旧模缺损尚未收口'}
                    />
                    <GateItem
                      pass={b.gate.caseChecked}
                      label="格位核对"
                      detail={
                        b.gate.caseChecked
                          ? `字盘版本与格位核对通过（${b.plan.length} 盘）`
                          : b.gate.caseIssues[0] ?? '存在未核对项'
                      }
                    />
                  </div>
                  {!b.gate.caseChecked && b.gate.caseIssues.length > 0 ? (
                    <ul className="space-y-0.5 text-[11px] text-seal" data-testid={`batch-issues-${b.id}`}>
                      {b.gate.caseIssues.map((issue, i) => (
                        <li key={i}>· {issue}</li>
                      ))}
                    </ul>
                  ) : null}

                  {b.status === 'rejected' && b.rejectReason ? (
                    <div className="rounded border border-seal/40 bg-seal-pale px-3 py-2 text-[11px] text-seal" data-testid={`batch-reject-${b.id}`}>
                      整批拒绝原因：{b.rejectReason}
                      <br />
                      请按上述提示修正后点「重新核对并重试」；草稿保留，可反复重试。
                    </div>
                  ) : null}

                  {b.status === 'migrated' ? (
                    <p className="text-[11px] text-jade" data-testid={`batch-done-${b.id}`}>
                      格位已迁到接替模，旧模「{source?.code ?? ''}」退役留档（状态停用），旧试印样张保留不删。
                    </p>
                  ) : null}

                  {/* 操作区 */}
                  {b.status !== 'migrated' ? (
                    <div className="space-y-2 border-t border-paper-line pt-3">
                      <ProofForm
                        key={`proof-${b.id}-${proofsOf(b.successorMatrixId).length}`}
                        matrixId={b.successorMatrixId}
                        character={successor?.character ?? ''}
                        defaultSampleNo={suggestSampleNo(todayStr(), proofsOf(b.successorMatrixId).length + 1)}
                        disabled={busyId === b.id}
                        onSubmit={(input) => handleProof(b, input)}
                      />
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          type="button"
                          className="mt-btn"
                          data-testid={`batch-refresh-${b.id}`}
                          disabled={busyId === b.id}
                          onClick={() => handleRefresh(b.id)}
                        >
                          刷新核对
                        </button>
                        {b.status === 'rejected' ? (
                          <button
                            type="button"
                            className="mt-btn mt-btn-primary"
                            data-testid={`batch-retry-${b.id}`}
                            disabled={busyId === b.id}
                            onClick={() => handleRetry(b.id)}
                          >
                            {busyId === b.id ? '重试中…' : '重新核对并重试'}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="mt-btn mt-btn-primary"
                            data-testid={`batch-confirm-${b.id}`}
                            disabled={busyId === b.id || !b.gate.proofClear || !b.gate.defectClosed || !b.gate.caseChecked}
                            onClick={() => handleConfirm(b.id)}
                          >
                            {busyId === b.id ? '迁移中…' : '确认迁移格位'}
                          </button>
                        )}
                        <button
                          type="button"
                          className="mt-btn"
                          data-testid={`batch-discard-${b.id}`}
                          disabled={busyId === b.id}
                          onClick={() => handleDiscard(b.id)}
                        >
                          放弃草稿
                        </button>
                        <span className="mt-hint">
                          两个标签页同时确认时只有一份能生效；迁移失败草稿保留，可重试。
                        </span>
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}

function GateItem({ pass, label, detail }: { pass: boolean; label: string; detail: string }) {
  return (
    <div
      className={`rounded border px-3 py-2 ${
        pass ? 'border-jade/40 bg-jade-pale/60' : 'border-paper-line bg-paper/50'
      }`}
      data-testid={`gate-${label}`}
    >
      <p className={`text-xs font-semibold ${pass ? 'text-jade' : 'text-ink-mute'}`}>
        {pass ? '✓' : '○'} {label}
      </p>
      <p className="mt-0.5 text-[11px] text-ink-soft">{detail}</p>
    </div>
  );
}

function ProofForm({
  matrixId,
  character,
  defaultSampleNo,
  disabled,
  onSubmit,
}: {
  matrixId: string;
  character: string;
  defaultSampleNo: string;
  disabled: boolean;
  onSubmit: (input: ProofInput) => void;
}) {
  const [pressure, setPressure] = useState('12.5');
  const [ink, setInk] = useState('油烟墨 101');
  const [impressions, setImpressions] = useState('40');
  const [sampleNo, setSampleNo] = useState(defaultSampleNo);
  const [clarity, setClarity] = useState<ClarityLevel>('清晰');
  const [proofDate, setProofDate] = useState(todayStr());

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit({
      targetKind: '字符',
      targetRef: character,
      matrixId,
      pressureKg: Number(pressure),
      ink,
      impressions: Number(impressions),
      sampleNo,
      clarity,
      proofDate,
    });
  };

  return (
    <form className="grid grid-cols-2 gap-2 md:grid-cols-6" onSubmit={handleSubmit} data-testid="recarve-proof-form">
      <div>
        <label className="mt-label" htmlFor={`rp-pressure-${defaultSampleNo}`}>
          压力 kg
        </label>
        <input
          id={`rp-pressure-${defaultSampleNo}`}
          type="number"
          min={PRESSURE_RANGE.min}
          max={PRESSURE_RANGE.max}
          step={0.5}
          className="mt-input"
          value={pressure}
          onChange={(e) => setPressure(e.target.value)}
        />
      </div>
      <div>
        <label className="mt-label" htmlFor={`rp-impressions-${defaultSampleNo}`}>
          印次
        </label>
        <input
          id={`rp-impressions-${defaultSampleNo}`}
          type="number"
          min={IMPRESSION_RANGE.min}
          max={IMPRESSION_RANGE.max}
          step={1}
          className="mt-input"
          value={impressions}
          onChange={(e) => setImpressions(e.target.value)}
        />
      </div>
      <div>
        <label className="mt-label" htmlFor={`rp-ink-${defaultSampleNo}`}>
          用墨
        </label>
        <input
          id={`rp-ink-${defaultSampleNo}`}
          className="mt-input"
          value={ink}
          onChange={(e) => setInk(e.target.value)}
        />
      </div>
      <div>
        <label className="mt-label" htmlFor={`rp-clarity-${defaultSampleNo}`}>
          清晰度
        </label>
        <select
          id={`rp-clarity-${defaultSampleNo}`}
          className="mt-input"
          value={clarity}
          onChange={(e) => setClarity(e.target.value as ClarityLevel)}
        >
          {CLARITY_LEVELS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div>
        <label className="mt-label" htmlFor={`rp-sampleno-${defaultSampleNo}`}>
          样张编号
        </label>
        <input
          id={`rp-sampleno-${defaultSampleNo}`}
          className="mt-input"
          value={sampleNo}
          onChange={(e) => setSampleNo(e.target.value)}
        />
      </div>
      <div className="flex items-end gap-2">
        <input
          type="date"
          className="mt-input"
          value={proofDate}
          onChange={(e) => setProofDate(e.target.value)}
          aria-label="试印日期"
        />
        <button type="submit" className="mt-btn mt-btn-primary whitespace-nowrap" disabled={disabled}>
          登记试印
        </button>
      </div>
    </form>
  );
}
