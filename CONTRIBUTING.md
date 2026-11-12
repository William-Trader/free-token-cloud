# 贡献指南

谢谢你想把免费源补得更全。这个项目的价值不在「数量」，而在**每条都能被验证**。请按下面规则来。

## 一条源要进清单，必须同时满足

| # | 要求 | 说明 |
|---|---|---|
| 1 | 合法来源 | 厂商官方免费层 / 官方试用赠金 / 官方匿名端点 / 用户自有订阅。**不接受**逆向聊天网页、共享或倒卖的 key、浏览器会话导出、CAPTCHA 绕过、多账号刷额度 |
| 2 | 官方出处 | 至少一个厂商官方文档、定价页或控制台链接；额度数字必须能在该页查到 |
| 3 | 交叉验证 | 至少一个公开清单（awesome list / 聚合器）或本项目历史审计记录 |
| 4 | 额度原文 | `quota` 写清限制口径（RPM / RPD / TPM / TPD / 有效期 / 是否需信用卡 / 是否限非商用），不要写「无限」「随便用」 |
| 5 | 分类与认证 | `category` 8 选 1，`auth` 6 选 1，见 `data/sources-policy.json` |
| 6 | 可复现核验 | `npm run sources:verify` 能探测到该源的官方 URL；401/403/405/429 视为在线 |

## 新增流程

```bash
# 1. 从每日自动发现的线索里找，或直接编辑种子
cat data/candidates.json | less

# 2. 在 scripts/sources-seed.mjs 的 SEEDS 里按同样字段补一条
#    必填：id name category auth region endpoint docsUrl quota models evidence confidence
#    confidence: official（官方页已核实） / aggregator（仅公开清单佐证） / community（社区汇总，待复核）
#    community 条目永远不进路由，status 保持 unverified

# 3. 重建注册表并跑全流程（幂等，不会覆盖已有校验状态）
npm run sources:init
npm run sources:all

# 4. 本地校验
npm run check && npm test

# 5. 提交
git add data docs scripts && git commit -m "feat(sources): add <provider>"
```

`data/sources.json` 是 **SSOT**，但 `status` / `verification` 两组字段由脚本维护，请只改种子与策略文件，不要手改这两组字段。
`provider-catalog.json`、`docs/SOURCES.md`、`docs/SOURCE-AUDIT.md`、`data/metrics.json`、README 源覆盖表都是**生成物**，不要直接编辑。

## 把「社区线索」升级为「官方已核实」

1. 打开厂商官方定价/限额页，确认额度、有效期、是否需要信用卡、是否限非商用。
2. 用官方 URL 替换 `evidence` 里的社区链接（或把社区链接降为第二条）。
3. `confidence` 改为 `official`，`quota` 改成官方原文摘要，去掉「社区汇总/待复核」措辞。
4. 在 `docs/SOURCE-AUDIT.md` 的人工决策记录里补一行，写清核实日期与结论。
5. 若确认已失效：把 `status` 置 `removed` 并写 `removedReason`，**不要删除条目**（保留墓碑）。

## 失效剔除规则

由 `data/sources-policy.json` 控制，不需要人工干预：

| 条件 | 动作 |
|---|---|
| 连续 2 次探测失败 | `active` → `degraded` |
| 连续 3 次探测失败 | → `deprecated` |
| 14 天未成功验证 | → `deprecated` |
| 30 天不可用 | → `removed`（保留 `removedAt` / `removedReason`） |
| 恢复可达 | `deprecated` → `active`（人工 `removed` 不自动恢复） |

单次失败不降级，避免网络抖动误杀。探测目标会依次尝试 docsUrl → pricingUrl → keyUrl → endpoint，单页 404 不会误判整个源失效。

## PR 检查清单

- [ ] `npm run check` 通过（语法 + 全部 JSON 可解析）
- [ ] `npm test` 28 个用例全绿
- [ ] `npm run sources:all` 跑通，`data/metrics.json` 数字合理
- [ ] 新增源有官方证据链接，额度数字没有夸大
- [ ] 没有把 API key、token、私钥、服务器内网 IP 写进任何文件
- [ ] 提交信息用 `feat: / fix: / docs: / chore: / refactor:` 前缀

## 提交归属

本地提交请固定使用仓库作者身份：

```bash
git config user.name "William-Trader"
git config user.email "331161833+William-Trader@users.noreply.github.com"
```

每日自动源刷新由 `github-actions[bot]` 提交，与人工提交分开，避免归属混淆。

## 争议处理

额度政策经常变。若官方页与清单冲突，**以官方页为准**，并在 `note` 里写明冲突与日期；若某源是否合规有争议，先标 `status=unverified` + `confidence=community`，不接入路由，等人工裁定。
