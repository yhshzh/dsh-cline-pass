# dsh-cline-pass

Connect [Cline Pass](https://cline.bot/cline-pass) subscription models to the [DeepSeek Harness](https://github.com/deepseek-ai). Install it as a dsh plugin and the models appear in the model list without running a proxy service.

## Features

- Use Cline Pass subscription models from dsh
- Streaming, tool calls, image input, and reasoning
- Multiple accounts with optional round-robin rotation
- Probe, test, pin, or exclude upstream channels
- Automatic failover before the first token
- Web settings panel and `cline_pass_*` tools

## Requirements

- dsh `>= 0.1.2-alpha.3 < 0.2.0`
- Node.js `>= 20.3`
- A Cline Pass API key

## Install

```bash
dsh plugin --profile web add dsh-cline-pass
```

You can also install a local directory or tarball:

```bash
dsh plugin --profile web add /path/to/dsh-cline-pass
dsh plugin --profile web add ./dsh-cline-pass-<version>.tgz
```

Restart dsh after installation.

## Configure

With the Web profile, open **Settings → Cline Pass** to save and test a key. Keys are stored in the dsh credential store and shown only in masked form.

You can also set an environment variable before starting dsh:

```bash
export CLINE_PASS_API_KEY=sk_xxx
dsh --profile web
```

### Multiple accounts

Add accounts in the settings panel and select single-account or round-robin mode. You can also use the tool interface:

```text
cline_pass_accounts action=add name=main key=sk_xxx
cline_pass_accounts action=add name=backup key=sk_yyy
cline_pass_accounts action=mode mode=roundrobin
```

### Configuration file

To override defaults, add a `cline-pass` section to your profile's `$DSH_HOME/profiles/<name>/cordis.patch.yml`:

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

Common settings include `baseURL`, `knownModels`, `models`, `perModel`, `exposeCatalog`, and `historyLimit`. The default gateway is `https://api.cline.bot/api/v1`.

## Upstream channels

For a new model, click **Auto-configure** in the panel to probe, validate, and configure channels. Expand a model row to adjust channel order or exclude a channel.

You can also run the tools in this order:

```text
cline_pass_probe    model=cline-pass/glm-5.2
cline_pass_validate model=cline-pass/glm-5.2
cline_pass_pin      model=cline-pass/glm-5.2 upstreams=["alibaba","baseten"] pinMode=preferred
```

`pinMode` supports `strict` and `preferred`. `preferred` tries channels in order and fails over before the first token when needed. Use `exclude` to block specific channels.

## Tools

| Tool | Purpose |
| --- | --- |
| `cline_pass_status` | Show route and account status |
| `cline_pass_models` | List models and channels |
| `cline_pass_probe` | Probe channels |
| `cline_pass_validate` | Test each channel |
| `cline_pass_test` | Verify the current settings |
| `cline_pass_pin` | Save channel settings |
| `cline_pass_accounts` | Manage accounts |
| `cline_pass_history` | Read request history |

## Development

```bash
npm test
npm run test:client
npm run test:mount
```

Live gateway checks are also available:

```bash
npm run test:live
npm run test:live:image
npm run test:live:reasoning
```

These commands need a valid Cline Pass key and make a small number of paid requests.

## Acknowledgements

Upstream channel and failover behavior was informed by the MIT-licensed [`cline-pass-switcher`](https://github.com/munmunjaklin458-afk/cline-pass-switcher).

## License

[MIT](LICENSE)
