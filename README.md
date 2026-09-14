# SkillAtlas · AI Skills 聚合发现平台

一个把你关心的 AI Agent Skills 从 GitHub 上真正采集、核验、分类、排行的本地平台。
直接双击 `index.html` 即可使用，不需要服务器或构建步骤。

## 数据是真的吗

是。页面上每一个条目都对应一个真实存在的 GitHub 仓库，链接直接指向该仓库。
数据集由 `tools/collect_skills.py` 通过官方 API 采集生成，不是手写的演示数据。

采集分四个阶段：

1. **search** — 用 GitHub Search API 跑 19 组关键词（`topic:claude-skills`、
   `topic:agent-skills`、`SKILL.md in:readme`、`topic:mcp-server` 等），
   每页 100 条，去重后得到候选仓库。
2. **verify** — 用 Git Tree API 递归读取仓库文件树，精确统计名为 `SKILL.md`
   的文件数量。这是最权威的口径，但匿名配额只有 60 次/小时。
3. **scan** — 用 jsDelivr 的包文件索引做同样的统计。它镜像同一份 GitHub
   文件树，没有实际配额限制，因此可以把核验覆盖到全部两千多个仓库。
   GitHub 口径优先，镜像口径补位，页面上两者分开标注。
4. **emit** — 合并元数据、剔除与 AI 无关的仓库、自动分类、计算趋势分，
   输出 `data/skills.json`、`data/meta.json` 和供 `file://` 直接加载的 `data/skills.js`。

## 目录结构

```
index.html                 页面入口，双击即可打开
styles.css                 样式
main.js                    数据加载、筛选、排序、渲染、弹窗
tools/collect_skills.py    采集器（可重复运行，增量缓存）
data/skills.json           完整数据集
data/skills.js             同一份数据，供 file:// 直接打开时使用
data/raw_repos.json        GitHub 搜索结果原始快照
data/verify_cache.json     GitHub 核验缓存，逐轮累积
data/jsdelivr_cache.json   jsDelivr 全量核验缓存
data/meta.json             采集统计
```

## 更新数据

Windows 下双击 `更新Skills数据.bat`，或手动执行：

```powershell
python tools/collect_skills.py search   # 约 5 分钟，受 10 次/分钟限制
python tools/collect_skills.py verify   # 受 60 次/小时限制，可分多次跑
python tools/collect_skills.py scan     # 免配额，约 6 分钟覆盖全部仓库
python tools/collect_skills.py emit
```

四个阶段互相独立且都有缓存，可以随时中断、下次接着跑。
`verify` 每跑一轮就多核验一批仓库，缓存会累积结果；`scan` 一次即可覆盖全量。

### 提升配额

GitHub 匿名访问限制很严（搜索 10 次/分钟、核心 60 次/小时）。
设置一个 token 可以把上限提到 5000 次/小时，采集速度和核验覆盖率都会大幅提升：

```powershell
$env:GITHUB_TOKEN = "ghp_xxx"
python tools/collect_skills.py all --verify-budget 500
```

## 榜单口径

趋势分 = 星标 × 0.45 + 日均星标 × 55 + Fork × 0.5 + 活跃度 × 25

- **日均星标** = 星标 / 仓库存在天数，用来让新项目有机会冒头
- **活跃度** 由最近一次 push 距今的天数换算，越近越高
- 分类由仓库名、描述和 topic 的关键词自动判定，人工可覆盖

## 发布与自动更新

纯静态站点，不需要服务器。仓库里已带一份数据快照，克隆后直接打开
`index.html` 就能用；线上推荐 GitHub Pages。

**开启 Pages**：仓库 `Settings → Pages → Build and deployment`，
Source 选 **GitHub Actions**。之后 `.github/workflows/refresh.yml`
每天自动跑一遍采集并发布，也可在 Actions 页面手动触发。

两个设计取舍：

- 刷新结果**只发布、不写回仓库**，所以每日更新不会让仓库体积膨胀。
- 工作流用 Actions 自带的 `GITHUB_TOKEN`，配额远高于匿名访问，线上版本的
  官方核验覆盖率比本地匿名跑高得多；采集失败会自动回退到已提交的快照。

**仓库里不放什么**：`data/raw_repos.json`（十几 MB 原始搜索结果）、
`data/verify_cache.json`、`data/jsdelivr_cache.json` 都是中间产物，
已写进 `.gitignore`，本地首次运行采集器会重新生成。

## 已知边界

- 数据是**采集时的快照**，不是实时流；页面顶部和底部都标了生成时间。
- 匿名运行时 GitHub 官方口径的核验数量受 60 次/小时限制；其余核验来自
  jsDelivr 镜像，两者计数可能有少量差异（例如同一仓库 790 与 903）。
- "趋势分"是自建启发式指标，不等同于 GitHub 官方 Trending。
- 分类是关键词规则，会有误判，例如把自动化平台归到"数据科学"。
- 采集器按关键词发现仓库，长尾但未被任何关键词命中的 skills 不会出现。

## 下一步可以做什么

- 增加 stars 时间序列，把"趋势"从估算换成真实的增长速度。
- 抓取 `SKILL.md` 正文，做技能级（而非仓库级）的检索与详情页。
- 为 Skill 和分类生成静态页面，让内容能被搜索引擎收录。
- 拆分数据集，首屏只加载轻量索引，详情按需拉取。
