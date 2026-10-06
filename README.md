# 活字字模与铅字档案（gbmovabletype）

面向活字印刷体验馆、铅字工坊与字体研究者的字模 / 字盘 / 试印档案工具：登记字模的字体、字号与材质，在行列网格上编辑字盘落位，记录缺笔磨损等损耗并据此停用或补刻。**纯前端单页应用**，数据全部保存在浏览器本地，不依赖任何后端服务、数据库或外部接口。

## Docker 一键启动（推荐）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后访问：**http://localhost:21829**

其它常用命令：

```bash
docker compose ps          # 查看容器状态（healthy 即就绪）
docker compose logs -f     # 查看 nginx 日志
docker compose down        # 停止并移除容器（数据在浏览器本地，不受影响）
```

## 技术栈

| 层次 | 选型 |
| --- | --- |
| 框架 | React 18 + TypeScript（严格模式） |
| 构建 | Vite 6，`npm run build` = `tsc -b && vite build`（含类型检查） |
| 样式 | Tailwind CSS v3 + PostCSS + Autoprefixer（无 UI 组件库，样式自写） |
| 状态 | Zustand（筛选偏好走 persist） |
| 路由 | React Router 6（`createBrowserRouter`） |
| 本地存储 | IndexedDB（Dexie，库名 `gbmovabletype-db`）+ localStorage（表单 / 布局草稿） |
| 部署 | 多阶段 Docker：`node:20-alpine` 构建 → `nginx:alpine` 托管静态产物 |

## 数据模型（`src/types/` 四个独立文件）

| 模型 | 文件 | 关键字段 |
| --- | --- | --- |
| TypeMatrix 字模 | `src/types/matrix.ts` | 字模编号、字符、字体（宋体/楷体/仿宋）、字号（初号 42pt … 八号 5pt 共 16 档）、材质（铜模/木活字/铅合金）、字面尺寸 mm、字身高度 mm、制作年代、刻工、可用性、**代际**（初代 = 1，接替模 = 前代 + 1）、**世系 id**、前代 / 接替模 id |
| TypeCase 字盘 | `src/types/case.ts` | 字盘编号、类型（常用字盘/生僻字盘）、行数、列数、格位布局（行/列/字符/字模 id）、所在工位、容量、**版本号**（迁移前核对） |
| DefectLog 缺损记录 | `src/types/defect.ts` | 字模 id、缺损类型（缺笔/磨损/变形/锈蚀/断裂）、程度（轻/中/重）、发现日期、处理方式、可用性（可用/停用/待补刻）、**是否收口** |
| ProofRecord 试印记录 | `src/types/proof.ts` | 字符或字盘、压力 kg、用墨、印次、样张编号、清晰度评价（清晰/偏淡/糊版）、试印日期 |
| RecarveBatch 代际补刻批次 | `src/types/recarve.ts` | 旧模 id、接替模 id、世系 id、状态（草稿/已迁移/已拒绝）、迁移计划（逐盘版本 + 格位）、收口条件（清晰试印 / 缺损收口 / 格位核对）、拒绝原因 |

### IndexedDB 版本与升级迁移（Dexie）

- **v1**：建 `matrices` 表（含 code / character / font / sizeName / material / availability 索引）
- **v2**：加 `cases` 表与 `matrixId` 多值索引；升级时按 `slots` 回填历史字盘的 `matrixId`
- **v3**：加 `defects`、`proofs` 表；升级时为「停用 / 待补刻」的历史字模回填缺损原因记录
- **v4**：加 `recarveBatches` 代际补刻批次表；升级时为旧字模回填代际（初代）、旧字盘回填版本号、旧缺损记录补收口标记

首次打开且库为空时会写入一批示例档案（16 枚字模、2 个字盘、5 条缺损、6 条试印），便于直接体验；已有数据则跳过。

## 页面与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | `Overview` | 字模总览：按字体 / 字号 / 材质 / 可用性筛选，卡片显示字符大样与缺损角标，可按部首笔画排序 |
| `/matrices/new` | `MatrixNew` | 字模登记：字符选择器按部首与笔画校验并给出候选，填写字体、字号、材质、尺寸与年代 |
| `/matrices/:id` | `MatrixDetail` | 字模详情：字面信息、所在字盘格位、缺损历史、试印记录，可就地新增缺损或试印、补刻恢复可用 |
| `/cases` | `CaseEditor` | 字盘布局编辑器：行列网格点击落位 / 取出 / 调换，实时提示空格与重复落位 |
| `/defects` | `DefectBoard` | 缺损登记：提交后自动停用字模并进入待补刻清单，补刻完成一键恢复 |
| `/proofs` | `ProofList` | 试印记录：登记压力、用墨与清晰度，按样张编号回溯试印批次 |
| `/recarves` | `RecarveBoard` | 代际补刻：待补刻字模先建立接替模（新模沿用旧编号、代际 +1），清晰试印与缺损收口后再把在盘格位迁过去；旧模与旧样张保留，迁移前核对字盘版本与格位 |

## 代际补刻流程（`/recarves`）

补刻师傅让新模沿用旧编号，但字盘、缺损记录与试印样张分不清实体，因此按代际区分：

1. **建立接替模**：为「待补刻 / 停用」字模建立一枚接替模，沿用旧编号与全部字面信息，仅代际 +1（初代 → 二代），世系 id 指向旧模；同时为旧模登记一条「代际补刻收口」缺损记录（`closed = true`）。旧模保持待补刻，旧样张保留不删。
2. **清晰试印**：在批次卡片上为接替模登记试印，清晰度必须为「清晰」（`proofClear`）。
3. **缺损收口**：旧模存在收口记录（`defectClosed`）。
4. **格位核对**：逐盘核对字盘版本号与格位是否仍为旧模落位（`caseChecked`）；若有别盘仍引用旧模、或计划字盘已变动，则整批拒绝。
5. **确认迁移**：三条件齐备后，在跨标签页互斥锁内把计划格位的 `matrixId` 从旧模换成接替模，字盘版本 +1，旧模退役为「停用」留档。

关键保证：

- **两个标签页同时提交确认只有一份生效**：迁移在 Web Locks（`navigator.locks`，不支持时回退 localStorage 互斥量）关键区内执行，进入后重新读库核对批次状态；第一个标签页把批次置为「已迁移」后，第二个标签页读到已迁移状态即中止。
- **整批拒绝与重试**：迁移前重新校验接替模可用性、清晰试印、缺损收口、字盘版本与格位、以及是否仍有别盘引用；任一不满足则整批置为「已拒绝」并写明原因，草稿保留，修正后可反复重试。
- **关页再开仍可继续**：批次草稿持久化在 IndexedDB `recarveBatches` 表，刷新或关闭浏览器后再开仍可继续；跨标签页通过 BroadcastChannel 同步批次状态。
- **旧档案补初代**：v4 升级时为缺失代际信息的旧字模回填「初代」（`generation = 1`，`lineageId = id`）。

## 目录结构

```
.
├── docker-compose.yml        # 无 version 字段；顶层 name: gbmovabletype
├── .env.example              # COMPOSE_PROJECT_NAME / FRONTEND_PORT
├── README.md
└── frontend/
    ├── Dockerfile            # 多阶段：node:20-alpine → nginx:alpine
    ├── nginx.conf            # try_files 前端路由兜底 + gzip
    ├── index.html
    ├── package.json          # build = tsc -b && vite build
    ├── tailwind.config.js / postcss.config.js / vite.config.ts
    ├── public/favicon.svg
    └── src/
        ├── types/{matrix,case,defect,proof}.ts
        ├── db/index.ts       # Dexie 库、版本迁移、示例档案
        ├── stores/{matrixStore,caseStore,uiStore}.ts
        ├── hooks/{useMatrixSearch,useLocalDraft,useCaseSlots}.ts
        ├── components/common/{MatrixCell,LayoutGrid,CharacterPicker,DefectBadge,EmptyState}.tsx
        ├── layouts/AppShell.tsx
        ├── pages/{Overview,MatrixNew,MatrixDetail,CaseEditor,DefectBoard,ProofList}.tsx
        ├── router/index.tsx
        └── utils/{charIndex,layout,format}.ts
```

## 数据存储说明

- **业务数据**：IndexedDB（Dexie，库名 `gbmovabletype-db`，共 5 张表 `matrices` / `cases` / `defects` / `proofs` / `recarveBatches`）。写入前统一 `toPlain()` 深拷贝，避免响应式对象写库抛 `DataCloneError`。
- **代际补刻草稿**：IndexedDB `recarveBatches` 表，持久化接替模建立、试印收口、格位迁移的全过程；关页再开仍可继续，迁移失败可重试。
- **草稿数据**：localStorage，前缀 `gbmovabletype-draft:`，覆盖字模登记、字盘布局、缺损登记、试印登记四处表单，刷新后可恢复。
- **界面偏好**：localStorage，键 `gbmovabletype-ui`（Zustand persist，保存筛选条件与当前选中字盘）。
- 容器完全无状态：不挂载命名卷、不连接数据库服务，删除重建容器不影响浏览器里的档案。

## 本地开发（可选）

```bash
cd frontend
npm install
npm run dev      # http://localhost:21829
npm run build    # 类型检查 + 生产构建
```

## 说明

- `frontend/public` 下静态资源已 `chmod 644`，Dockerfile 运行阶段额外 `chmod -R a+rX`，避免 nginx worker 读不到导致 favicon 403。
- 所有表单的数值输入均带 `min` / `max` 约束，枚举字段提供固定选项，不在前端做自由文本写入。
