import Dexie, { type Table } from 'dexie';
import type { CaseSlot, TypeCase } from '../types/case';
import type { DefectLog } from '../types/defect';
import type { DefectSeverity, DefectType } from '../types/defect';
import { MATRIX_AVAILABILITIES, type MatrixAvailability, type MatrixFont, type MatrixMaterial, type TypeMatrix } from '../types/matrix';
import { ptOfSize } from '../types/matrix';
import type { ProofRecord } from '../types/proof';
import type { RecutJob, RecutPlanSlot, RecutStatus } from '../types/recut';
import { matrixIdsOf } from '../utils/layout';
import { suggestCaseCode, suggestMatrixCode, toPlain } from '../utils/format';

export const DB_NAME = 'gbmovabletype-db';

/**
 * 浏览器本地库：IndexedDB（Dexie）
 * v1 建 matrices
 * v2 加 cases 表与 matrixId 索引
 * v3 加 defects / proofs 表，并为停用字模回填缺损原因
 * v4 加 recuts 表（代际补刻工程），字模补代际 / 谱系字段，字盘补布局版本与格位代际；
 *    旧档案没有代际信息的一律补成初代（generation=1、lineageId=自身 id）
 */
class MovableTypeDb extends Dexie {
  matrices!: Table<TypeMatrix, string>;
  cases!: Table<TypeCase, string>;
  defects!: Table<DefectLog, string>;
  proofs!: Table<ProofRecord, string>;
  recuts!: Table<RecutJob, string>;

  constructor() {
    super(DB_NAME);
    this.version(1).stores({
      matrices: 'id, code, character, font, sizeName, material, availability',
    });
    this.version(2)
      .stores({
        matrices: 'id, code, character, font, sizeName, material, availability',
        cases: 'id, code, kind, workStation, *matrixId',
      })
      .upgrade(async (tx) => {
        // v2：历史字盘可能只有 slots，没有维护 matrixId 多值索引，这里按 slots 回填
        const table = tx.table('cases');
        const rows: TypeCase[] = await table.toArray();
        for (const row of rows) {
          const ids = matrixIdsOf(row.slots ?? []);
          const current = row.matrixId ?? [];
          const same = ids.length === current.length && ids.every((id, i) => id === current[i]);
          if (!same) await table.update(row.id, { matrixId: ids });
        }
      });
    this.version(3)
      .stores({
        matrices: 'id, code, character, font, sizeName, material, availability',
        cases: 'id, code, kind, workStation, *matrixId',
        defects: 'id, matrixId, defectType, severity, availability, foundDate',
        proofs: 'id, matrixId, sampleNo, clarity, proofDate',
      })
      .upgrade(async (tx) => {
        // v3：为历史「停用 / 待补刻」字模回填一条缺损原因记录，保证停用有据可查
        const matrices: TypeMatrix[] = await tx.table('matrices').toArray();
        const existed: DefectLog[] = await tx.table('defects').toArray();
        const covered = new Set(existed.map((d) => d.matrixId));
        for (const m of matrices) {
          if (m.availability === '可用') continue;
          if (covered.has(m.id)) continue;
          covered.add(m.id);
          await tx.table('defects').add({
            id: `dft-mig-${m.id}`,
            matrixId: m.id,
            character: m.character,
            matrixCode: m.code,
            defectType: m.availability === '待补刻' ? '变形' : '磨损',
            severity: '中',
            foundDate: (m.updatedAt || new Date().toISOString()).slice(0, 10),
            handling:
              m.availability === '待补刻'
                ? '版本升级迁移：由停用状态转入待补刻清单'
                : '版本升级迁移：补登停用原因，等待补刻或重铸',
            availability: m.availability,
            operator: '系统迁移',
            note: '由 v2 → v3 升级自动回填',
            createdAt: new Date().toISOString(),
          });
        }
      });
    this.version(4)
      .stores({
        matrices: 'id, code, character, font, sizeName, material, availability, generation, lineageId, replacesId',
        cases: 'id, code, kind, workStation, *matrixId',
        defects: 'id, matrixId, defectType, severity, availability, foundDate',
        proofs: 'id, matrixId, sampleNo, clarity, proofDate',
        recuts: 'id, oldMatrixId, successorMatrixId, code, status',
      })
      .upgrade(async (tx) => {
        // v4：旧档案没有代际信息，统一补成初代
        const matrixTable = tx.table<TypeMatrix, string>('matrices');
        const matrices: TypeMatrix[] = await matrixTable.toArray();
        for (const m of matrices) {
          const generation = Number(m.generation) >= 1 ? Number(m.generation) : 1;
          const lineageId = typeof m.lineageId === 'string' && m.lineageId ? m.lineageId : m.id;
          const replacesId = typeof m.replacesId === 'string' ? m.replacesId : '';
          if (
            m.generation !== generation ||
            m.lineageId !== lineageId ||
            m.replacesId !== replacesId
          ) {
            await matrixTable.update(m.id, { generation, lineageId, replacesId });
          }
        }

        // v4：字盘补布局版本号（既有布局从 v1 计起），格位补代际（旧格位上的都是初代）
        const caseTable = tx.table<TypeCase, string>('cases');
        const typeCases: TypeCase[] = await caseTable.toArray();
        for (const c of typeCases) {
          const version = Number(c.version) >= 1 ? Number(c.version) : 1;
          const slots: CaseSlot[] = (c.slots ?? []).map((s) => ({
            ...s,
            matrixGen: Number(s.matrixGen) >= 1 ? Number(s.matrixGen) : 1,
          }));
          await caseTable.update(c.id, { version, slots });
        }
      });
  }
}

export const db = new MovableTypeDb();

interface SeedMatrix {
  id: string;
  code: string;
  character: string;
  font: MatrixFont;
  sizeName: string;
  material: MatrixMaterial;
  faceWidthMm: number;
  bodyHeightMm: number;
  madeYear: number;
  engraver: string;
  availability: MatrixAvailability;
  note: string;
  /** 不传时按初代处理；接替模显式给代际与谱系 */
  generation?: number;
  lineageId?: string;
  replacesId?: string;
}

const SEED_MATRICES: SeedMatrix[] = [
  { id: 'm-1001', code: 'ZM-1985-001', character: '活', font: '宋体', sizeName: '初号', material: '铜模', faceWidthMm: 15.2, bodyHeightMm: 23, madeYear: 1985, engraver: '王守仁', availability: '可用', note: '馆藏一号铜模，字面平整' },
  { id: 'm-1002', code: 'ZM-1978-002', character: '字', font: '宋体', sizeName: '一号', material: '铅合金', faceWidthMm: 9, bodyHeightMm: 13.5, madeYear: 1978, engraver: '李墨林', availability: '可用', note: '' },
  { id: 'm-1003', code: 'ZM-1978-003', character: '印', font: '宋体', sizeName: '二号', material: '铅合金', faceWidthMm: 7.6, bodyHeightMm: 11, madeYear: 1978, engraver: '李墨林', availability: '可用', note: '' },
  { id: 'm-1004', code: 'ZM-1990-004', character: '刷', font: '宋体', sizeName: '三号', material: '铅合金', faceWidthMm: 5.6, bodyHeightMm: 8.2, madeYear: 1990, engraver: '陈之安', availability: '可用', note: '' },
  { id: 'm-1005', code: 'ZM-1962-005', character: '排', font: '楷体', sizeName: '四号', material: '木活字', faceWidthMm: 4.9, bodyHeightMm: 7.4, madeYear: 1962, engraver: '周介庵', availability: '待补刻', note: '枣木活字，受潮后需补刻' },
  { id: 'm-1006', code: 'ZM-1962-006', character: '版', font: '楷体', sizeName: '五号', material: '木活字', faceWidthMm: 3.7, bodyHeightMm: 5.6, madeYear: 1962, engraver: '周介庵', availability: '可用', note: '' },
  { id: 'm-1007', code: 'ZM-1975-007', character: '铅', font: '仿宋', sizeName: '三号', material: '铜模', faceWidthMm: 5.5, bodyHeightMm: 8, madeYear: 1975, engraver: '王守仁', availability: '可用', note: '' },
  { id: 'm-1008', code: 'ZM-1993-008', character: '模', font: '宋体', sizeName: '小四', material: '铜模', faceWidthMm: 4.2, bodyHeightMm: 6.4, madeYear: 1993, engraver: '陈之安', availability: '停用', note: '字面中部磨损，已停用' },
  { id: 'm-1009', code: 'ZM-1971-009', character: '铜', font: '仿宋', sizeName: '四号', material: '铜模', faceWidthMm: 4.8, bodyHeightMm: 7.2, madeYear: 1971, engraver: '吴少泉', availability: '可用', note: '' },
  { id: 'm-1010', code: 'ZM-1965-010', character: '刻', font: '楷体', sizeName: '二号', material: '铅合金', faceWidthMm: 7.5, bodyHeightMm: 11.2, madeYear: 1965, engraver: '周介庵', availability: '可用', note: '' },
  { id: 'm-1011', code: 'ZM-1988-011', character: '墨', font: '宋体', sizeName: '五号', material: '铅合金', faceWidthMm: 3.6, bodyHeightMm: 5.5, madeYear: 1988, engraver: '陈之安', availability: '停用', note: '下部横画缺笔，停用待补刻' },
  { id: 'm-1012', code: 'ZM-1958-012', character: '纸', font: '仿宋', sizeName: '小五', material: '木活字', faceWidthMm: 3.2, bodyHeightMm: 4.9, madeYear: 1958, engraver: '吴少泉', availability: '可用', note: '' },
  { id: 'm-1013', code: 'ZM-1980-013', character: '宋', font: '宋体', sizeName: '小初', material: '铜模', faceWidthMm: 12.6, bodyHeightMm: 19, madeYear: 1980, engraver: '王守仁', availability: '可用', note: '大字铜模，试印样张留档' },
  { id: 'm-1014', code: 'ZM-1995-014', character: '体', font: '楷体', sizeName: '六号', material: '铅合金', faceWidthMm: 2.7, bodyHeightMm: 4.1, madeYear: 1995, engraver: '李墨林', availability: '待补刻', note: '字身底部断裂，待重铸' },
  { id: 'm-1015', code: 'ZM-1968-015', character: '匠', font: '仿宋', sizeName: '五号', material: '铜模', faceWidthMm: 3.8, bodyHeightMm: 5.6, madeYear: 1968, engraver: '吴少泉', availability: '可用', note: '' },
  { id: 'm-1016', code: 'ZM-1991-016', character: '序', font: '宋体', sizeName: '小五', material: '铅合金', faceWidthMm: 3.3, bodyHeightMm: 5, madeYear: 1991, engraver: '陈之安', availability: '可用', note: '' },
  // 代际补刻示例：「排」二代接替模已两关齐备、待迁移；「体」二代接替模尚在验收
  { id: 'm-1017', code: 'ZM-1962-005', character: '排', font: '楷体', sizeName: '四号', material: '木活字', faceWidthMm: 4.9, bodyHeightMm: 7.4, madeYear: 2026, engraver: '周介庵', availability: '可用', note: '二代接替模：枣木重刻，清晰试印合格、缺损收口', generation: 2, lineageId: 'm-1005', replacesId: 'm-1005' },
  { id: 'm-1018', code: 'ZM-1995-014', character: '体', font: '楷体', sizeName: '六号', material: '铅合金', faceWidthMm: 2.7, bodyHeightMm: 4.1, madeYear: 2026, engraver: '李墨林', availability: '验收中', note: '二代接替模：字身重铸，待清晰试印与缺损收口', generation: 2, lineageId: 'm-1014', replacesId: 'm-1014' },
];

interface SeedSlot {
  row: number;
  col: number;
  matrixId: string;
  character: string;
  matrixGen?: number;
}

const SEED_CASE_A_SLOTS: SeedSlot[] = [
  { row: 0, col: 0, matrixId: 'm-1001', character: '活' },
  { row: 0, col: 1, matrixId: 'm-1002', character: '字' },
  { row: 0, col: 2, matrixId: 'm-1003', character: '印' },
  { row: 0, col: 3, matrixId: 'm-1004', character: '刷' },
  { row: 1, col: 0, matrixId: 'm-1005', character: '排' },
  { row: 1, col: 1, matrixId: 'm-1006', character: '版' },
  { row: 1, col: 2, matrixId: 'm-1007', character: '铅' },
  { row: 1, col: 3, matrixId: 'm-1009', character: '铜' },
  { row: 2, col: 0, matrixId: 'm-1010', character: '刻' },
  { row: 2, col: 1, matrixId: 'm-1012', character: '纸' },
  { row: 2, col: 2, matrixId: 'm-1013', character: '宋' },
  { row: 2, col: 3, matrixId: 'm-1014', character: '体' },
];

const SEED_CASE_B_SLOTS: SeedSlot[] = [
  { row: 0, col: 0, matrixId: 'm-1015', character: '匠' },
  { row: 0, col: 1, matrixId: 'm-1016', character: '序' },
];

interface SeedDefect {
  id: string;
  matrixId: string;
  defectType: DefectType;
  severity: DefectSeverity;
  foundDate: string;
  handling: string;
  availability: MatrixAvailability;
  operator: string;
  note: string;
}

const SEED_DEFECTS: SeedDefect[] = [
  { id: 'dft-2001', matrixId: 'm-1008', defectType: '磨损', severity: '中', foundDate: '2025-03-18', handling: '字面中部磨损，先停用并登记补刻评估', availability: '停用', operator: '陈之安', note: '磨损深度约 0.15mm' },
  { id: 'dft-2002', matrixId: 'm-1011', defectType: '缺笔', severity: '重', foundDate: '2025-04-02', handling: '「墨」字下部横画缺笔，停用并列入补刻清单', availability: '停用', operator: '李墨林', note: '' },
  { id: 'dft-2003', matrixId: 'm-1005', defectType: '变形', severity: '轻', foundDate: '2025-02-11', handling: '木活字受潮轻微变形，阴干后复测仍不合格，转待补刻', availability: '待补刻', operator: '周介庵', note: '字面翘曲 0.2mm' },
  { id: 'dft-2004', matrixId: 'm-1014', defectType: '断裂', severity: '重', foundDate: '2025-05-06', handling: '字身底部断裂，停用待重铸', availability: '待补刻', operator: '李墨林', note: '' },
  { id: 'dft-2005', matrixId: 'm-1008', defectType: '锈蚀', severity: '轻', foundDate: '2024-11-20', handling: '铜模表面轻微锈蚀，擦拭除锈后继续使用', availability: '可用', operator: '吴少泉', note: '例行保养记录' },
  { id: 'dft-2006', matrixId: 'm-1017', defectType: '变形', severity: '轻', foundDate: '2026-09-25', handling: '二代接替模复测：前代受潮翘曲未复现，缺损收口，准予试印', availability: '可用', operator: '周介庵', note: '代际补刻收口记录' },
];

interface SeedProof {
  id: string;
  targetKind: '字符' | '字盘';
  targetRef: string;
  matrixId: string;
  pressureKg: number;
  ink: string;
  impressions: number;
  sampleNo: string;
  clarity: '清晰' | '偏淡' | '糊版';
  proofDate: string;
  note: string;
}

const SEED_PROOFS: SeedProof[] = [
  { id: 'pfr-3001', targetKind: '字符', targetRef: '活', matrixId: 'm-1001', pressureKg: 12.5, ink: '油烟墨 101', impressions: 40, sampleNo: 'YZ-20250512-01', clarity: '清晰', proofDate: '2025-05-12', note: '字口饱满，留作标准样张' },
  { id: 'pfr-3002', targetKind: '字符', targetRef: '字', matrixId: 'm-1002', pressureKg: 10, ink: '松烟墨 08', impressions: 32, sampleNo: 'YZ-20250512-02', clarity: '偏淡', proofDate: '2025-05-12', note: '压力偏低，建议加压至 12kg' },
  { id: 'pfr-3003', targetKind: '字符', targetRef: '墨', matrixId: 'm-1011', pressureKg: 14, ink: '油烟墨 101', impressions: 25, sampleNo: 'YZ-20250513-01', clarity: '糊版', proofDate: '2025-05-13', note: '缺笔叠加糊版，判定停用' },
  { id: 'pfr-3004', targetKind: '字盘', targetRef: 'ZP-A-01', matrixId: '', pressureKg: 18.5, ink: '油烟墨 101', impressions: 60, sampleNo: 'YZ-20250518-01', clarity: '清晰', proofDate: '2025-05-18', note: '整盘试印，行列对齐良好' },
  { id: 'pfr-3005', targetKind: '字符', targetRef: '模', matrixId: 'm-1008', pressureKg: 11.5, ink: '松烟墨 08', impressions: 28, sampleNo: 'YZ-20250520-03', clarity: '糊版', proofDate: '2025-05-20', note: '磨损导致笔画发虚' },
  { id: 'pfr-3006', targetKind: '字符', targetRef: '纸', matrixId: 'm-1012', pressureKg: 9.5, ink: '松烟墨 08', impressions: 50, sampleNo: 'YZ-20250601-01', clarity: '清晰', proofDate: '2025-06-01', note: '' },
  // 二代「排」接替模的清晰样张：清晰试印关据此判定通过
  { id: 'pfr-3007', targetKind: '字符', targetRef: '排', matrixId: 'm-1017', pressureKg: 10.5, ink: '油烟墨 101', impressions: 36, sampleNo: 'YZ-20260926-01', clarity: '清晰', proofDate: '2026-09-26', note: '二代接替模试印，字口清晰，准予上盘迁移' },
];

interface SeedRecut {
  id: string;
  oldMatrixId: string;
  successorMatrixId: string;
  status: RecutStatus;
  engraver: string;
  reason: string;
  createdAt: string;
}

const SEED_RECUTS: SeedRecut[] = [
  {
    id: 'rct-4001',
    oldMatrixId: 'm-1005',
    successorMatrixId: 'm-1017',
    status: '待迁移',
    engraver: '周介庵',
    reason: '木活字受潮翘曲 0.2mm，按补刻师傅要求沿用编号 ZM-1962-005 重刻二代',
    createdAt: '2026-09-20T09:00:00.000Z',
  },
  {
    id: 'rct-4002',
    oldMatrixId: 'm-1014',
    successorMatrixId: 'm-1018',
    status: '待验收',
    engraver: '李墨林',
    reason: '字身底部断裂，沿用编号 ZM-1995-014 重铸二代',
    createdAt: '2026-09-28T09:00:00.000Z',
  },
];

function buildSeed() {
  const now = new Date().toISOString();
  const matrices: TypeMatrix[] = SEED_MATRICES.map((m) => ({
    ...m,
    sizePt: ptOfSize(m.sizeName),
    generation: m.generation ?? 1,
    lineageId: m.lineageId ?? m.id,
    replacesId: m.replacesId ?? '',
    createdAt: now,
    updatedAt: now,
  }));
  const matrixById = new Map(matrices.map((m) => [m.id, m]));
  const toSlots = (rows: SeedSlot[]): CaseSlot[] =>
    rows.map((s) => ({ ...s, matrixGen: s.matrixGen ?? 1, placedAt: now }));
  const cases: TypeCase[] = [
    {
      id: 'case-1001',
      code: suggestCaseCode(1),
      kind: '常用字盘',
      rows: 6,
      cols: 8,
      slots: toSlots(SEED_CASE_A_SLOTS),
      workStation: '一号排字工位',
      matrixId: matrixIdsOf(toSlots(SEED_CASE_A_SLOTS)),
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    {
      id: 'case-1002',
      code: suggestCaseCode(2),
      kind: '生僻字盘',
      rows: 4,
      cols: 6,
      slots: toSlots(SEED_CASE_B_SLOTS),
      workStation: '二号排字工位',
      matrixId: matrixIdsOf(toSlots(SEED_CASE_B_SLOTS)),
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
  ];
  const defects: DefectLog[] = SEED_DEFECTS.map((d) => {
    const m = matrixById.get(d.matrixId);
    return {
      ...d,
      character: m?.character ?? '',
      matrixCode: m?.code ?? '',
      createdAt: now,
    };
  });
  const proofs: ProofRecord[] = SEED_PROOFS.map((p) => ({ ...p, createdAt: now }));

  // 补刻工程的格位计划与字盘版本在写入时按当前字盘实况扫描，保证示例自洽
  const recuts: RecutJob[] = SEED_RECUTS.map((r) => {
    const oldMatrix = matrixById.get(r.oldMatrixId);
    const successor = matrixById.get(r.successorMatrixId);
    const planSlots: RecutPlanSlot[] = [];
    const caseVersions: Record<string, number> = {};
    for (const c of cases) {
      const hits = c.slots.filter((s) => s.matrixId === r.oldMatrixId);
      if (hits.length === 0) continue;
      caseVersions[c.id] = c.version;
      for (const s of hits) {
        planSlots.push({ caseId: c.id, caseCode: c.code, row: s.row, col: s.col, character: s.character });
      }
    }
    const created = r.createdAt;
    return {
      id: r.id,
      oldMatrixId: r.oldMatrixId,
      successorMatrixId: r.successorMatrixId,
      code: successor?.code ?? oldMatrix?.code ?? '',
      character: oldMatrix?.character ?? '',
      successorGeneration: successor?.generation ?? 2,
      status: r.status,
      engraver: r.engraver,
      reason: r.reason,
      planSlots,
      caseVersions,
      lastError: '',
      createdAt: created,
      updatedAt: now,
      migratedAt: r.status === '已迁移' ? now : '',
      canceledAt: '',
    };
  });

  return { matrices, cases, defects, proofs, recuts };
}

let seedPromise: Promise<void> | null = null;

async function doSeed(): Promise<void> {
  const count = await db.matrices.count();
  if (count > 0) return;
  const seed = toPlain(buildSeed());
  await db.transaction(
    'rw',
    db.matrices,
    db.cases,
    db.defects,
    db.proofs,
    db.recuts,
    async () => {
      await db.matrices.bulkPut(seed.matrices);
      await db.cases.bulkPut(seed.cases);
      await db.defects.bulkPut(seed.defects);
      await db.proofs.bulkPut(seed.proofs);
      await db.recuts.bulkPut(seed.recuts);
    },
  );
}

/** 首次打开时写入示例档案；已有数据则跳过。并发调用共享同一个 Promise。 */
export function ensureSeed(): Promise<void> {
  if (!seedPromise) {
    seedPromise = doSeed().catch((err) => {
      seedPromise = null;
      throw err;
    });
  }
  return seedPromise;
}

/** 按可用性统计字模数量（复用 availability 索引） */
export async function countByAvailability(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const a of MATRIX_AVAILABILITIES) {
    out[a] = await db.matrices.where('availability').equals(a).count();
  }
  return out;
}

export { suggestMatrixCode, suggestCaseCode };
