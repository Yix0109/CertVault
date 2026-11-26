# app/ui-ids.md — 界面骨架与样式约定（dev-ui 交付说明）

> 本文件说明 `app/index.html` + `app/style.css` 的结构与命名约定，给 app.js 接线（dev-wiring）/文档（dev-docs）/后续维护者看。
> 契约 id 清单以 `docs/工程契约-v1.md` §5 为准：82 个 id 已全部落在 index.html 中，**id 名与元素类型不要改**。

## 1. 文件职责

| 文件 | 内容 | 谁维护 |
| --- | --- | --- |
| `app/index.html` | 纯骨架：顶栏 / KPI / 工具栏 / 筛选 / 表格 / 状态栏 / 抽屉 / 设置 / 编辑弹窗 / 提醒弹窗 / 日志 / 右键菜单 / toast / 锁横幅 / 两个隐藏 file input。无内联事件、无业务脚本 | dev-ui（脚本区除外，见 §6） |
| `app/style.css` | 全部视觉（深墨蓝底 + 香槟金主按钮 + 四态徽章），文件顶部有分区注释 | dev-ui |
| `app/app.js` | 动态渲染与交互，**整体替换 `#tbody`**、动态生成抽屉/弹窗内容 | dev-wiring |
| `app/ui-check.png` | 交付自检截图：真实 1680×1000、已连接 app.js 的 17 条演示数据主视图 | dev-ui |

## 2. 显隐约定（重要）

- **浮层统一用 `.open` 类**（默认不可见、不可点）：
  `#scrim`、`#drawer`、`#settingsPanel`、`#logPanel`、`#modal`、`#remindModal`、`#ctxMenu`、`#toast`。
  抽屉/设置/日志是右侧滑入（`transform`），弹窗是居中淡入（`opacity + scale`），右键菜单是 `display:block`，toast 是底部居中淡入。
  接线层 `showOverlay(el)` / `hideOverlay(el)` 即"加/删 .open"，不要用 `style.display` 控制。
- **静态隐藏用 `[hidden]` 属性**（CSS 有 `[hidden]{display:none!important}`）：
  `#emptyState`、`#lockBanner`、`#btnReconnect`、`#fileInput`、`#imgInput`；`#bellBadge` 在无提醒时也置 `hidden`。
- 遮罩层 `#scrim` 与浮层各自独立开关；多个浮层不建议同时打开（app.js 的 `SCRIM_LAYERS` 已按单层处理）。
- 不要给 `<body>` / `<html>` 加状态类；不要把 `.open` 用到表行上（表行选中用 `tr.sel`）。

## 3. 表格（12 列固定）

- 列顺序：勾选 / # / 平台名称（第二行小字域名）/ 网址 / 账户 / 密码 / CA 口令 / 截止有效期 / 到期状态 / 提醒 / 截图 / 备注。
- `<colgroup>` 固定 12 列宽（`c-ck 40 / c-idx 46 / c-name 208 / c-url 188 / c-acc 172 / c-pwd 122 / c-ca 114 / c-exp 106 / c-status 130 / c-remind 72 / c-shot 78 / c-note auto`，合计 1638），表头 sticky，表格横向不滚动。
- **绝对不要给 `tr` 加 `::before` / `::after`**（会生成匿名单元格，导致整行错位一列，原型踩过坑）。
- app.js 渲染的行模板类名（已全部有样式）：
  `td.ck > input.rowchk`、`td.idx`、`td.name > span.n + span.u`、`td.url > a`、`td.mono`、
  密码单元格 `td > span.secret > span.val + button.cp[data-field]`（`data-field="password"` / `"ca"`）、
  状态 `span.badge.over|soon|ok|none`（可含 `span.d`）、`td.remind`（关闭提醒时加 `.off`）、
  `td.shot > span.tb + span.c`、备注 `td[title]`。
- 选中行加 `tr.sel`（左侧 2px 金色条）；表头全选 `#table thead .chk-all`（app.js 维护 `checked/indeterminate`）。
- `#tbody` 由 app.js 整体 `innerHTML` 替换；`#emptyState` 在 `<tbody>` 之外（空态时表头保留、提示居中在表头下方），只切 `hidden`。
- 允许保留 6 行 `class="demo"` 静态示例行：仅用于未接线时验版式，首次渲染会被整体替换。

## 4. app.js 动态内容用到的 class（已有样式，勿删）

- 详情抽屉 `#drawerBody`：`.card > h3`（小标签）+ `.kv`（`.k`/`.v`，`.v.mono`/`.v.mask`）+ `.hint`；截图墙 `.gallery`（内 `.ph > img + .tag`，缺图时用 `:before/:after` 画占位）；操作行 `.row-actions`（内 `.mini` 按钮）。`#drawerFoot` 由 app.js 填按钮，空时 CSS `:empty` 自动隐藏。
- 编辑弹窗 `#modal`：`.form > .fld`（`.fld.full` 占两列）、`.inp`、`.hint`；拖放区 `.drop`（拖入高亮类 `.dragover`，悬停 `.hover`），缩略图列表 `#thumbList.thumbs > .thumb`（内含 `img` / `.f` 文件名 / `button.x` 移除）。
- 到期提醒 `#remindList`：`.ritem > .nm(b + small) + .rt(.badge + .hint)`，右侧徽章与剩余天数同一行；`#remindCount` 由 app.js 只写数字，文案前后缀由 CSS 伪元素补成「共 N 条需要关注」。
- 日志 `#logList`：`<li><b>操作</b><span>时间 · 详情</span></li>`。
- toast：`#toast` 加 `.open` + `textContent`（不要 `innerHTML`，文案纯文本）。
- 右键菜单：`#ctxMenu` 加 `.open`，位置由 app.js 写 `style.left/top`（唯一允许的行内样式）；8 项 `data-act` 固定：`name|url|account|password|ca|expiry|edit|delete`，表单字段→菜单项不要增减。
- 显示密码按钮 `#btnShowPwd`：图标 + `<span class="lbl">显示密码</span>`；切文案改 `.lbl.textContent`（"显示密码"/"隐藏密码"），并给按钮切 `.on`/`.primary`。
- 抽屉里的截图大图预览由 app.js 动态创建（内联样式，无 class），不依赖本 CSS。

## 5. 设置面板与提醒控件

- 开关：`button.sw[aria-checked="true"]` 加 `.on`（金色）；`#stInterval` 用原生 `<select class="sel">`（1/4/12/24 小时 + 0=每天一次）。
- 数据位置区 `#stRoot/#stDbSize/#stImgInfo` 是 `.kv` 的 `.v` 单元格，直接写 `textContent`；禁用状态用 `.muted`。
- `#drawerFoot`：按钮文案为「编辑记录 / 取消提醒（或恢复提醒）/ 删除」，删除用 `.btn.danger`。

## 6. 脚本区（Lead 维护，勿回退）

- `</body>` 前固定顺序三个 **classic script**：`core.js` → `store.js` → `app.js`，随后是启动看门狗（2.5s 未 `window.__CV_BOOTED__` 则显示 `#lockBanner` 提示）。
- **不要改成 `type="module"`**：Edge/Chrome 在 `file://` 下会拦截外部 module（CORS），双击打不开；三个脚本已改为 IIFE + `window.CVCore/CVStore` 全局命名空间。
- 新增页面脚本前先找 Lead，加载顺序不要打乱。

## 7. 自检方法与当前数字

- 视觉自检（真实 1680×1000，需 CDP）：`Emulation.setDeviceMetricsOverride{width:1680,height:1000,deviceScaleFactor:1}` + `Page.captureScreenshot{clip:0,0,1680,1000}`。
  ⚠ Edge 146 的 `--headless=new --window-size=1680,1000` 实际视口只有 1656×908（右侧 24px、底部 92px 是窗口装饰留白），用任务给的 `--screenshot` 命令只能看"内容按 1656 排版"的近似图；最终截图走 CDP。
- 打开方式：`file:///.../app/index.html`（classic script 现在无需 `--allow-file-access-from-files` 也能启动；启动器 bat 仍带该参数，无副作用）。
- 当前实测（1680×1000，17 条演示数据）：`document.scrollWidth = clientWidth = 1680`（无横向滚动条）、`scrollHeight = clientHeight = 1000`；行高统一 48px；12 列 `#table thead th` 与 `td` 左边界最大偏差 0px；徽章被裁切 0 处；单元格内容溢出 0 处；状态栏 bottom = 983（距视口底 17px）；`#emptyState` 空态时位于表头下方居中。
- 82 个契约 id 全部存在（脚本内校验 missing=[]）；6 行 demo 静态示例可被 app.js 整体替换。

## 8. 修改纪律

- 不要覆盖 `app/style.css` 整份；需要新样式先在本文件登记或找 dev-ui 局部追加，保持"表格列宽 / 浮层 .open 约定 / 徽章四态"不变。
- `app/index.html` 的 82 个 id、12 列表头、`#emptyState` 位置、脚本区（§6）都是契约/集成约束，不要重排或改名。
- 视觉问题（错位、截断、溢出、浮层样式）找 dev-ui；逻辑/接线问题（数据、事件、CSV、提醒）找 dev-wiring。
