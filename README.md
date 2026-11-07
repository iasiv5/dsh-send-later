# dsh-send-later

DSH 插件：在输入框旁设定延时或指定时间，向当前会话发送一条消息（默认「继续」）。适合「coding plan 五小时额度用尽 → 等额度恢复后续跑会话」这类场景。

## 功能

- 发送按钮左侧出现一个时钟按钮。点开后可选 10 分钟后、30 分钟后、1 小时后、5 小时后，或指定日期和时间；发送内容默认「继续」，可改。
- 片段条：「发送内容」旁固定两颗快捷胶囊——`⚡安全继续`（带边界的继续文案）和最近一条自定义输入；自定义文案排程成功后自动记录，长文案原地截断、悬停看全文。
- 按钮角标显示本会话待发送的数量；面板里列出每条待发送（相对时间，悬停看绝对时刻），点 ✕ 即可取消。
- 面板顶部显示当前会话标题，多会话并行时不排错目标；装了 dsh-quota-watch 时还会显示 GLM 5 小时额度的预计恢复时间。
- 上次用的发送内容和时长会记住，重开面板自动带出。
- 手机上软键盘弹出时面板自动避开键盘（visualViewport 感知）；窄屏（<480px）下面板贴底全宽展示。
- 投递使用 DSH 官方的自动化任务（`schedule`）：任务持久化，重启不丢；也可在「自动化任务」页查看、暂停或删除。
- 纯前端插件：没有 Host 侧代码，不需要配置。

## 安装

要求 DSH ≥ 0.2.2-rc.1。

```bash
git clone https://github.com/iasiv5/dsh-send-later.git
cd dsh-send-later && npm install
```

然后在 DSH 会话里用 `plugin_manager` 工具的 `install_bundle` 动作安装，`target` 填仓库目录的绝对路径，装完刷新页面。

npm 包 [dsh-send-later](https://www.npmjs.com/package/dsh-send-later) 与本仓库同步发布；`0.0.x` 是占位版本，请使用 0.2.0 及以上。

## 开发与测试

```bash
npm install   # 安装 react / react-dom / jsdom（仅测试用，不进入运行时依赖）
npm test      # jsdom 离线渲染测试：面板、预设、排程请求、取消、待发列表、重复提交
npm run security:check   # 依赖红线检查（运行时依赖必须为空）
```

## 发布

发版 = 打 tag：`npm version x.y.z && git push --tags`，GitHub Actions 以 OIDC Trusted Publishing 自动发布（workflow 见 `.github/workflows/publish.yml`）。

## 已知限制

- 到点时如果模型额度仍未恢复，这条消息会失败，需要重新排程（额度恢复时间仅供参考，以服务商实际刷新为准）。
- 额度恢复时间依赖 dsh-quota-watch 插件提供的数据；未安装时该行自动隐藏。
- 会话被归档后，投递会被拒绝。
- DSH Host 必须在线才能投递；停机期间错过的一次性任务如何补发，尚未测试。
- 待发送列表按「本插件创建的任务 + 带标题前缀的同会话任务」识别；在「自动化任务」页把标题前缀改掉后不再被识别。

## 许可

MIT License，见 [LICENSE](LICENSE)。
