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

## 代际补刻（同编号不同实体）

补刻师傅要求新模沿用旧编号，但字盘格位、缺损记录、试印样张必须能分清是哪一代实体。流程分三步走：

1. **建立接替模**（`/recuts`）：待补刻旧模先另立一枚新实体，沿用旧 `code`，`generation +1`、记录 `lineageId` / `replacesId`，初置「验收中」（不可普通落位）。旧模、旧缺损、旧样张原样保留。
2. **两关验收**：接替模至少登记一张「清晰」试印、且未收口缺损全部复测合格；两关齐备后接替模自动转「可用」，工程进入「待迁移」。
3. **整批迁移格位**：勾选多个待迁移工程一次性提交。提交前与事务内都会核对字盘 `version`（乐观锁）与格位归属——
   - 计划内格位已被取出 / 调换、旧模仍被计划之外的别盘别格引用、接替模不可用，**整批拒绝**，单个 IndexedDB 事务回滚，任何数据都不动；
   - 两个标签页同时提交同一批时，字盘写入采用版本条件更新（compare-and-set），后到者更新 0 行整批回滚，**只有一份生效**；外层另有 Web Locks / localStorage 跨标签页锁尽早拦截；
   - 迁移失败原因写回工程记录，批次勾选存 localStorage 草稿，**关页再开可恢复重试**；
   - 迁移成功：格位 `matrixId / matrixGen` 换成接替模、字盘版本 +1，旧模转停用但实体保留，旧缺损与旧样张仍挂旧模 id，详情页「代际谱系」可逐代回溯。

进行中的补刻工程持久化在 IndexedDB 的 `recuts` 表，**关页再开仍可继续**。

## 数据模型（`src/types/` 五个独立文件）

| 模型 | 文件 | 关键字段 |
| --- | --- | --- |
| TypeMatrix 字模 | `src/types/matrix.ts` | 字模编号、字符、字体（宋体/楷体/仿宋）、字号（初号 42pt … 八号 5pt 共 16 档）、材质（铜模/木活字/铅合金）、字面尺寸 mm、字身高度 mm、制作年代、刻工、可用性（含接替模专用「验收中」）、代际 generation / 谱系 lineageId / replacesId |
| TypeCase 字盘 | `src/types/case.ts` | 字盘编号、类型（常用字盘/生僻字盘）、行数、列数、格位布局（行/列/字符/字模 id/**代际 matrixGen**）、所在工位、容量、**布局版本 version（乐观锁）** |
| DefectLog 缺损记录 | `src/types/defect.ts` | 字模 id、缺损类型（缺笔/磨损/变形/锈蚀/断裂）、程度（轻/中/重）、发现日期、处理方式、可用性（可用/停用/待补刻） |
| ProofRecord 试印记录 | `src/types/proof.ts` | 字符或字盘、压力 kg、用墨、印次、样张编号、清晰度评价（清晰/偏淡/糊版）、试印日期 |
| RecutJob 补刻工程 | `src/types/recut.ts` | 旧模 / 接替模 id、沿用编号、接替代际、状态（待验收/待迁移/已迁移/已取消）、待迁格位快照、字盘版本快照、最近一次整批拒绝原因 |

### IndexedDB 版本与升级迁移（Dexie）

- **v1**：建 `matrices` 表（含 code / character / font / sizeName / material / availability 索引）
- **v2**：加 `cases` 表与 `matrixId` 多值索引；升级时按 `slots` 回填历史字盘的 `matrixId`
- **v3**：加 `defects`、`proofs` 表；升级时为「停用 / 待补刻」的历史字模回填缺损原因记录
- **v4**：加 `recuts` 表；字模加 `generation / lineageId / replacesId` 索引，字盘加布局 `version`、格位加 `matrixGen`；升级时**旧档案没有代际信息的一律补成初代**（`generation=1`、`lineageId=自身 id`），字盘版本从 v1 起算

首次打开且库为空时会写入一批示例档案（18 枚字模含两枚二代接替模、2 个字盘、6 条缺损、7 条试印、2 个补刻工程：一个待迁移、一个待验收），便于直接体验；已有数据则跳过。

## 页面与路由

| 路由 | 页面 | 说明 |
| --- | --- | --- |
| `/` | `Overview` | 字模总览：按字体 / 字号 / 材质 / 可用性筛选，卡片显示字符大样与缺损角标，可按部首笔画排序 |
| `/matrices/new` | `MatrixNew` | 字模登记：字符选择器按部首与笔画校验并给出候选，填写字体、字号、材质、尺寸与年代 |
| `/matrices/:id` | `MatrixDetail` | 字模详情：字面信息、所在字盘格位、缺损历史、试印记录，可就地新增缺损或试印、补刻恢复可用 |
| `/cases` | `CaseEditor` | 字盘布局编辑器：行列网格点击落位 / 取出 / 调换，实时提示空格与重复落位 |
| `/defects` | `DefectBoard` | 缺损登记：提交后自动停用字模并进入待补刻清单，补刻完成一键恢复 |
| `/recuts` | `RecutBoard` | 代际补刻：建接替模 → 清晰试印 / 缺损收口两关验收 → 核对字盘版本后整批迁移格位，旧模旧样张保留 |
| `/proofs` | `ProofList` | 试印记录：登记压力、用墨与清晰度，按样张编号回溯试印批次 |

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
        ├── types/{matrix,case,defect,proof,recut}.ts
        ├── db/index.ts       # Dexie 库、版本迁移（v1–v4）、示例档案
        ├── stores/{matrixStore,caseStore,recutStore,uiStore}.ts
        ├── hooks/{useMatrixSearch,useLocalDraft,useCaseSlots}.ts
        ├── components/common/{MatrixCell,LayoutGrid,CharacterPicker,DefectBadge,EmptyState}.tsx
        ├── components/recut/RecutJobCard.tsx
        ├── layouts/AppShell.tsx
        ├── pages/{Overview,MatrixNew,MatrixDetail,CaseEditor,DefectBoard,RecutBoard,ProofList}.tsx
        ├── router/index.tsx
        └── utils/{charIndex,layout,recut,migrationLock,format}.ts
```

## 数据存储说明

- **业务数据**：IndexedDB（Dexie，库名 `gbmovabletype-db`，共 5 张表 `matrices` / `cases` / `defects` / `proofs` / `recuts`）。写入前统一 `toPlain()` 深拷贝，避免响应式对象写库抛 `DataCloneError`。
- **草稿数据**：localStorage，前缀 `gbmovabletype-draft:`，覆盖字模登记、字盘布局、缺损登记、试印登记、**补刻建模表单、整批迁移勾选**六处表单，刷新 / 关页后可恢复。
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
