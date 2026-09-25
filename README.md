# dsh-cline-pass

将 [Cline Pass](https://cline.bot/cline-pass) 订阅模型接入 [DeepSeek Harness](https://github.com/deepseek-ai)。安装为 dsh 插件后，模型会直接出现在模型列表中，无需运行代理服务。

## 功能

- 使用 Cline Pass 订阅模型
- 支持流式输出、工具调用、图片和 reasoning
- 管理多个账号并轮询使用
- 探测、测试、钉住或排除上游渠道
- 在首个 token 前自动故障转移
- 提供 Web 设置面板和 `cline_pass_*` 工具

## 要求

- dsh `>= 0.1.2-alpha.3`
- Node.js `>= 20.3`
- Cline Pass API Key

## 安装

```bash
dsh plugin --profile web add dsh-cline-pass
```

也可以安装本地目录或 tarball：

```bash
dsh plugin --profile web add /path/to/dsh-cline-pass
dsh plugin --profile web add ./dsh-cline-pass-<version>.tgz
```

安装后重启 dsh。

## 配置

Web profile 可以在 **设置 → Cline Pass** 中保存和测试 Key。Key 会存入 dsh 凭据库，界面只显示掩码。

也可以在启动 dsh 前设置环境变量：

```bash
export CLINE_PASS_API_KEY=sk_xxx
dsh --profile web
```

### 多账号

在设置面板中添加账号，并选择单账号或轮询模式。也可以调用工具：

```text
cline_pass_accounts action=add name=main key=sk_xxx
cline_pass_accounts action=add name=backup key=sk_yyy
cline_pass_accounts action=mode mode=roundrobin
```

### 配置文件

需要覆盖默认值时，在 profile 的 `$DSH_HOME/profiles/<name>/cordis.patch.yml` 中添加：

```yaml
- id: cline-pass
  config:
    accountMode: roundrobin
    accounts:
      main:
        apiKeyEnv: CLINE_PASS_MAIN_KEY
      backup:
        apiKeyEnv: CLINE_PASS_BACKUP_KEY
```

常用设置包括 `baseURL`、`knownModels`、`models`、`perModel`、`exposeCatalog` 和 `historyLimit`。默认网关地址为 `https://api.cline.bot/api/v1`。`maxConcurrentRequests` 限制每个账号同时发往网关的流数，默认 16，超出的请求排队等待空位，设为 `0` 表示不限。

## 上游渠道

首次使用模型时，可以在面板点击 **一键配置**，自动探测、校验和配置渠道。展开模型行可调整渠道顺序或排除渠道。

也可以按以下顺序调用工具：

```text
cline_pass_probe    model=cline-pass/glm-5.2
cline_pass_validate model=cline-pass/glm-5.2
cline_pass_pin      model=cline-pass/glm-5.2 upstreams=["alibaba","baseten"] pinMode=preferred
```

`pinMode` 支持 `strict` 和 `preferred`。`preferred` 会按顺序尝试渠道，并在首个 token 前失败时自动切换。`exclude` 可排除指定渠道。

## 工具

| 工具 | 用途 |
| --- | --- |
| `cline_pass_status` | 查看路由和账号状态 |
| `cline_pass_models` | 查看模型和渠道 |
| `cline_pass_probe` | 探测渠道 |
| `cline_pass_validate` | 测试每个渠道 |
| `cline_pass_test` | 验证当前设置 |
| `cline_pass_pin` | 保存渠道设置 |
| `cline_pass_accounts` | 管理账号 |
| `cline_pass_history` | 查看请求历史 |

## 开发

```bash
npm test
npm run test:client
npm run test:mount
```

访问真实网关的测试还包括：

```bash
npm run test:live
npm run test:live:image
npm run test:live:reasoning
```

这些命令需要有效的 Cline Pass Key，并会产生少量请求费用。

## 致谢

上游渠道和故障转移行为参考了 MIT 许可的 [`cline-pass-switcher`](https://github.com/munmunjaklin458-afk/cline-pass-switcher)。

## 友情链接

[LinuxDo](https://linux.do/) — 真诚、友善、团结、专业，你的品质开源与技术社区

## License

[MIT](LICENSE)
