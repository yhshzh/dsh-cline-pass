# dsh-cline-pass

[![npm](https://img.shields.io/npm/v/dsh-cline-pass)](https://www.npmjs.com/package/dsh-cline-pass)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

中文 | [English](README.en.md)

将 [Cline Pass](https://cline.bot/cline-pass) 订阅模型接入 [DeepSeek Harness（dsh）](https://github.com/deepseek-ai)，直接在模型列表中使用，无需部署代理服务。

## 功能

- 支持流式输出、工具调用、图片输入和推理，具体能力取决于模型。
- 多账号管理，支持单账号与轮询模式。
- 探测、校验、指定或排除上游渠道，支持首个 token 前的故障转移。
- 提供 Web 设置面板和可选的 `cline_pass_*` 管理工具。

## 快速开始

需要 Node.js `>= 20.3.0`、dsh `>= 0.1.2-alpha.3 < 0.3.0` 和有效的 Cline Pass API Key。

```bash
dsh plugin --profile web add dsh-cline-pass
```

安装后重启 dsh，在 **设置 → Cline Pass** 中保存并测试 API Key，然后在模型选择器中选择 Cline Pass 模型。Key 存入 dsh 凭据库，界面仅显示掩码。

也可以通过环境变量配置：

```bash
export CLINE_PASS_API_KEY="your-cline-pass-api-key"
dsh --profile web
```

以上使用 `web` profile，如需使用其他 profile，请替换对应名称。

## 配置

日常配置可在 Web 面板完成。通过文件配置时，修改对应 profile 的 `$DSH_HOME/profiles/<name>/cordis.patch.yml`，例如：

```yaml
- id: cline-pass
  config:
    accountMode: roundrobin
    accounts:
      main:
        apiKeyEnv: CLINE_PASS_MAIN_KEY
      backup:
        apiKeyEnv: CLINE_PASS_BACKUP_KEY
    exposeTools: false
```

`apiKeyEnv` 指向凭据名称或环境变量，请分别配置两个账号的 Key。管理工具默认关闭，需要时将 `exposeTools` 设为 `true`，并重启 dsh。

默认网关为 `https://api.cline.bot/api/v1`，每个账号的并发请求上限为 `16`（`maxConcurrentRequests`，`0` 表示不限）。更多选项见 [`lib/index.js`](lib/index.js)，管理工具见 [`lib/tools.js`](lib/tools.js)。

## 上游渠道

在设置面板中展开模型行，依次点击 **探测 → 校验**，保存渠道顺序或排除列表后，点击 **测试** 验证。

- `strict`：每次尝试限制到指定的候选渠道。
- `preferred`：向网关传递渠道偏好顺序，必要时尝试后续候选渠道。

校验会向每个渠道发送真实请求，不会修改已保存的规则；可重试的故障转移发生在首个 token 输出前。

## 开发与贡献

项目使用 JavaScript ES Modules，无需编译。安装依赖后运行：

```bash
npm install
npm test
npm run test:client
npm run test:mount
```

测试需要兼容版本的 dsh 相关包，挂载测试还需要完整的 dsh 安装。`npm run test:live`、`npm run test:live:image` 和 `npm run test:live:reasoning` 会访问真实网关，需要有效 Key 并消耗额度或产生费用。

欢迎提交 [Issue](https://github.com/yhshzh/dsh-cline-pass/issues) 或 Pull Request。报告问题时请附版本、复现步骤及脱敏日志；提交代码前请运行相关测试。

## 致谢

上游渠道和故障转移行为参考了 MIT 许可的 [`cline-pass-switcher`](https://github.com/munmunjaklin458-afk/cline-pass-switcher)。

## 友情链接

[LinuxDo](https://linux.do/) — 真诚、友善、团结、专业，你的品质开源与技术社区

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=yhshzh/dsh-cline-pass&type=Date)](https://www.star-history.com/#yhshzh/dsh-cline-pass&Date)

## 许可证

[MIT](LICENSE)
