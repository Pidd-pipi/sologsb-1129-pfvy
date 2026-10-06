import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMatrixStore } from '../../stores/matrixStore';
import { useRecutStore } from '../../stores/recutStore';
import { useUiStore } from '../../stores/uiStore';
import type { RecutJob } from '../../types/recut';
import { IMPRESSION_RANGE, PRESSURE_RANGE } from '../../types/proof';
import { generationLabel } from '../../types/matrix';
import { formatDate, formatStamp, suggestSampleNo, todayStr } from '../../utils/format';
import { evaluateRecutGate, slotLabel } from '../../utils/recut';

export interface RecutJobCardProps {
  job: RecutJob;
  selected: boolean;
  onToggleSelect: (jobId: string) => void;
  onChanged: () => Promise<void>;
}

const STATUS_STYLE: Record<string, string> = {
  待验收: 'border-brass/50 bg-brass-pale text-brass',
  待迁移: 'border-seal/50 bg-seal-pale text-seal',
  已迁移: 'border-jade/50 bg-jade-pale text-jade',
  已取消: 'border-paper-line bg-paper-deep text-ink-mute',
};

/** 单个代际补刻工程卡片：旧模 / 接替模、验收两关、迁移格位计划与操作 */
export default function RecutJobCard({ job, selected, onToggleSelect, onChanged }: RecutJobCardProps) {
  const matrices = useMatrixStore((s) => s.matrices);
  const proofs = useMatrixStore((s) => s.proofs);
  const defects = useMatrixStore((s) => s.defects);
  const addSuccessorProof = useRecutStore((s) => s.addSuccessorProof);
  const closeSuccessorDefect = useRecutStore((s) => s.closeSuccessorDefect);
  const rescanPlan = useRecutStore((s) => s.rescanPlan);
  const cancelRecut = useRecutStore((s) => s.cancelRecut);
  const pushToast = useUiStore((s) => s.pushToast);

  const [proofForm, setProofForm] = useState({
    pressureKg: '12',
    ink: '油烟墨 101',
    impressions: '40',
    sampleNo: suggestSampleNo(todayStr(), 1),
    proofDate: todayStr(),
    note: '',
  });
  const [closeOperator, setCloseOperator] = useState(job.engraver);
  const [busy, setBusy] = useState(false);

  const oldMatrix = matrices.find((m) => m.id === job.oldMatrixId);
  const successor = matrices.find((m) => m.id === job.successorMatrixId);
  const successorProofs = proofs.filter((p) => p.matrixId === job.successorMatrixId);
  const successorDefects = defects.filter((d) => d.matrixId === job.successorMatrixId);
  const gate = evaluateRecutGate(successor, successorProofs, successorDefects);

  const guard = async (fn: () => Promise<void>, okText?: string) => {
    setBusy(true);
    try {
      await fn();
      await onChanged();
      if (okText) pushToast(okText);
    } catch (err) {
      pushToast(err instanceof Error ? err.message : '操作失败', 'error');
    } finally {
      setBusy(false);
    }
  };

  const slotsByCase = new Map<string, typeof job.planSlots>();
  for (const slot of job.planSlots) {
    const arr = slotsByCase.get(slot.caseCode) ?? [];
    arr.push(slot);
    slotsByCase.set(slot.caseCode, arr);
  }

  return (
    <li className="rounded-md border border-paper-line bg-white/70 px-4 py-3" data-testid={`recut-job-${job.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-song text-xl text-ink">{job.character}</span>
            <span className="text-xs text-ink-mute" data-testid={`recut-code-${job.id}`}>
              {job.code}
            </span>
            <span className={`mt-chip ${STATUS_STYLE[job.status] ?? ''}`} data-testid={`recut-status-${job.id}`}>
              {job.status}
            </span>
            {job.status === '待迁移' ? (
              <label className="flex items-center gap-1 text-xs text-ink-soft">
                <input
                  type="checkbox"
                  data-testid={`recut-select-${job.id}`}
                  checked={selected}
                  onChange={() => onToggleSelect(job.id)}
                />
                加入本批迁移
              </label>
            ) : null}
          </div>
          <p className="text-[11px] text-ink-soft">{job.reason}</p>
          <p className="text-[11px] text-ink-mute">
            建立于 {formatStamp(job.createdAt)} · 刻工 {job.engraver}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-[11px]">
          <Link className="mt-btn mt-btn-ghost" to={`/matrices/${job.oldMatrixId}`} data-testid={`recut-old-link-${job.id}`}>
            旧模（{generationLabel(oldMatrix?.generation ?? 1)}）
          </Link>
          <Link
            className="mt-btn mt-btn-ghost"
            to={`/matrices/${job.successorMatrixId}`}
            data-testid={`recut-successor-link-${job.id}`}
          >
            接替模（{generationLabel(job.successorGeneration)}）
          </Link>
        </div>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="rounded border border-paper-line bg-paper/50 px-3 py-2 text-[11px] text-ink-soft">
          <p className="font-semibold text-ink">旧模（保留实体，不迁旧样张）</p>
          <p data-testid={`recut-old-state-${job.id}`}>
            {oldMatrix?.availability ?? '档案缺失'} · {oldMatrix?.font}/{oldMatrix?.sizeName} · {oldMatrix?.material}
          </p>
          <p className="mt-1 text-ink-mute">旧缺损与旧试印记录继续挂在旧模 id 下，迁移后仍可在详情页回溯。</p>
        </div>
        <div className="rounded border border-paper-line bg-paper/50 px-3 py-2 text-[11px] text-ink-soft">
          <p className="font-semibold text-ink">接替模（沿用编号的新一代实体）</p>
          <p data-testid={`recut-successor-state-${job.id}`}>
            {successor?.availability ?? '档案缺失'} · {generationLabel(job.successorGeneration)} ·{' '}
            {successor?.madeYear} 年刻
          </p>
          <div className="mt-1 flex flex-wrap gap-2">
            <GateTag pass={gate.hasClearProof} label="清晰试印" testId={`gate-proof-${job.id}`} />
            <GateTag pass={gate.defectsClosed} label="缺损收口" testId={`gate-defect-${job.id}`} />
          </div>
        </div>
      </div>

      {job.status === '待验收' ? (
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
          <form
            className="rounded border border-paper-line px-3 py-2"
            data-testid={`clear-proof-form-${job.id}`}
            onSubmit={(e) => {
              e.preventDefault();
              void guard(async () => {
                await addSuccessorProof({
                  jobId: job.id,
                  pressureKg: Number(proofForm.pressureKg),
                  ink: proofForm.ink,
                  impressions: Number(proofForm.impressions),
                  sampleNo: proofForm.sampleNo,
                  proofDate: proofForm.proofDate,
                  note: proofForm.note,
                });
              }, '已登记接替模的清晰试印样张');
            }}
          >
            <h4 className="font-song text-sm font-semibold text-ink">① 清晰试印收口</h4>
            <p className="mt-0.5 text-[11px] text-ink-mute">接替模试印 {successorProofs.length} 张（清晰 {successorProofs.filter((p) => p.clarity === '清晰').length} 张）</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="text-[11px] text-ink-soft">
                压力 kg
                <input
                  className="mt-input"
                  type="number"
                  min={PRESSURE_RANGE.min}
                  max={PRESSURE_RANGE.max}
                  step={0.5}
                  value={proofForm.pressureKg}
                  onChange={(e) => setProofForm((p) => ({ ...p, pressureKg: e.target.value }))}
                />
              </label>
              <label className="text-[11px] text-ink-soft">
                印次
                <input
                  className="mt-input"
                  type="number"
                  min={IMPRESSION_RANGE.min}
                  max={IMPRESSION_RANGE.max}
                  value={proofForm.impressions}
                  onChange={(e) => setProofForm((p) => ({ ...p, impressions: e.target.value }))}
                />
              </label>
              <label className="text-[11px] text-ink-soft">
                用墨
                <input
                  className="mt-input"
                  value={proofForm.ink}
                  onChange={(e) => setProofForm((p) => ({ ...p, ink: e.target.value }))}
                />
              </label>
              <label className="text-[11px] text-ink-soft">
                试印日期
                <input
                  className="mt-input"
                  type="date"
                  value={proofForm.proofDate}
                  onChange={(e) => setProofForm((p) => ({ ...p, proofDate: e.target.value }))}
                />
              </label>
              <label className="col-span-2 text-[11px] text-ink-soft">
                样张编号
                <input
                  className="mt-input"
                  value={proofForm.sampleNo}
                  data-testid={`clear-proof-sample-${job.id}`}
                  onChange={(e) => setProofForm((p) => ({ ...p, sampleNo: e.target.value }))}
                />
              </label>
            </div>
            <button
              type="submit"
              className="mt-btn mt-btn-primary mt-2"
              disabled={busy || gate.hasClearProof}
              data-testid={`clear-proof-submit-${job.id}`}
            >
              {gate.hasClearProof ? '清晰试印已收口' : '登记清晰样张'}
            </button>
          </form>

          <form
            className="rounded border border-paper-line px-3 py-2"
            data-testid={`close-defect-form-${job.id}`}
            onSubmit={(e) => {
              e.preventDefault();
              void guard(async () => {
                await closeSuccessorDefect({ jobId: job.id, operator: closeOperator });
              }, '接替模缺损已收口');
            }}
          >
            <h4 className="font-song text-sm font-semibold text-ink">② 缺损收口</h4>
            <p className="mt-0.5 text-[11px] text-ink-mute">
              接替模未收口缺损 {successorDefects.filter((d) => d.availability !== '可用').length} 条
            </p>
            <label className="mt-2 block text-[11px] text-ink-soft">
              收口确认人
              <input
                className="mt-input"
                value={closeOperator}
                onChange={(e) => setCloseOperator(e.target.value)}
                placeholder="例：周介庵"
              />
            </label>
            <button
              type="submit"
              className="mt-btn mt-btn-primary mt-2"
              disabled={busy || gate.defectsClosed}
              data-testid={`close-defect-submit-${job.id}`}
            >
              {gate.defectsClosed ? '缺损已收口' : '缺损复测合格，收口'}
            </button>
            <p className="mt-2 text-[11px] text-ink-soft">
              两关齐备后接替模自动转「可用」，工程进入待迁移；可到试印页另行登记偏淡 / 糊版样张留档。
            </p>
          </form>
        </div>
      ) : null}

      {job.status === '待迁移' ? (
        <div className="mt-3 rounded border border-seal/30 bg-seal-pale/40 px-3 py-2" data-testid={`migration-plan-${job.id}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="font-song text-sm font-semibold text-ink">待迁移格位（共 {job.planSlots.length} 格）</h4>
            <button
              type="button"
              className="mt-btn"
              disabled={busy}
              data-testid={`rescan-plan-${job.id}`}
              onClick={() =>
                void guard(async () => {
                  await rescanPlan(job.id);
                }, '已按当前字盘重新核对格位')
              }
            >
              重新核对格位
            </button>
          </div>
          {job.planSlots.length === 0 ? (
            <p className="mt-1 text-[11px] text-ink-mute">旧模当前不在任何字盘格位上：迁移只切换代际档案、不动格位。</p>
          ) : (
            <ul className="mt-1 space-y-1 text-[11px] text-ink-soft">
              {Array.from(slotsByCase.entries()).map(([caseCode, slots]) => (
                <li key={caseCode}>
                  字盘 {caseCode}：
                  {slots.map((s) => `${slotLabel(s)}（${s.character}）`).join('、')}
                </li>
              ))}
            </ul>
          )}
          {job.lastError ? (
            <p className="mt-2 rounded border border-seal/40 bg-white/80 px-2 py-1 text-[11px] text-seal" data-testid={`recut-error-${job.id}`}>
              上次整批迁移被拒绝：{job.lastError}。请重新核对后重试，草稿仍保留。
            </p>
          ) : null}
        </div>
      ) : null}

      {job.status === '已迁移' ? (
        <p className="mt-3 text-[11px] text-jade" data-testid={`migrated-at-${job.id}`}>
          已于 {formatDate((job.migratedAt || '').slice(0, 10))} 完成格位迁移，旧模停用留存，{job.successorGeneration} 代接替模上盘。
        </p>
      ) : null}
      {job.status === '已取消' ? (
        <p className="mt-3 text-[11px] text-ink-mute">工程已于 {formatStamp(job.canceledAt)} 取消，接替模停用归档。</p>
      ) : null}

      {job.status === '待验收' || job.status === '待迁移' ? (
        <div className="mt-2">
          <button
            type="button"
            className="mt-btn text-[11px]"
            disabled={busy}
            data-testid={`cancel-recut-${job.id}`}
            onClick={() => {
              if (!window.confirm('确定取消该补刻工程？接替模会停用归档（实体保留）。')) return;
              void guard(async () => {
                await cancelRecut(job.id, job.engraver);
              }, '补刻工程已取消');
            }}
          >
            取消补刻工程
          </button>
        </div>
      ) : null}
    </li>
  );
}

function GateTag({ pass, label, testId }: { pass: boolean; label: string; testId: string }) {
  return (
    <span
      className={`mt-chip ${pass ? 'border-jade/50 text-jade' : 'border-brass/50 text-brass'}`}
      data-testid={testId}
      data-pass={pass ? '1' : '0'}
    >
      {pass ? '✓' : '○'} {label}
    </span>
  );
}
