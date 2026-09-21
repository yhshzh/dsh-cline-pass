/**
 * dsh-cline-pass — browser half.
 *
 * A hand-written dsh client bundle: the module system loads it with
 * `window.__ModuleLoader__.load`, and the Cordis Loader treats the returned
 * exports as an ordinary plugin (`apply` + `inject`). Plain CJS with no build
 * step, so `require` reaches only the shell's platform seed table — `react`.
 *
 * It adds a Cline Pass page in Settings (the same card on the Plugins page) and
 * a compact key card on the Models page. Every read and write goes to the
 * authenticated `/api/cline-pass` route published by `lib/panel.js`, so the
 * panel and the `cline_pass_*` tools share one source of truth.
 *
 * @module dsh-cline-pass/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-cline-pass',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement

    /** Locale namespace this card owns. */
    const NS = 'cline-pass'
    /** Exact `/api` Fetch route the host half publishes. */
    const PANEL_PATH = '/api/cline-pass'
    /** Human label for the upstream verdict vocabulary. */
    const VERDICT = { ok: 'available', limited: 'rate-limited', bad: 'not-pinnable', auth: 'auth-failed', 'not-adopted': 'not-adopted', unknown: 'unknown' }

    //#region styles

    const CSS = [
      '.cp-panel{max-width:820px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:14px;font-size:13px}',
      '.cp-title{margin:0;font-size:18px;font-weight:600}',
      '.cp-card{border:0.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:10px}',
      '.cp-card-title{font-weight:600;font-size:13px;display:flex;align-items:center;gap:8px;justify-content:space-between}',
      '.cp-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.cp-grow{flex:1;min-width:120px}',
      '.cp-muted{color:var(--dsw-alias-label-tertiary)}',
      '.cp-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}',
      '.cp-input,.cp-select{background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);border:0.5px solid var(--dsw-alias-border-l2);border-radius:6px;padding:6px 8px;font-size:13px;min-width:0}',
      '.cp-input:focus-visible,.cp-select:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.cp-btn{border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:6px;padding:5px 10px;font-size:12px;cursor:pointer}',
      '.cp-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}',
      '.cp-btn:disabled{opacity:.5;cursor:default}',
      '.cp-btn-primary{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);font-weight:600}',
      '.cp-btn-danger{color:var(--dsw-alias-state-error-primary)}',
      '.cp-dot{width:8px;height:8px;border-radius:50%;display:inline-block;flex:none}',
      '.cp-table{display:flex;flex-direction:column;gap:6px}',
      '.cp-account,.cp-model{border:0.5px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:8px}',
      '.cp-chips{display:flex;flex-wrap:wrap;gap:6px}',
      '.cp-chip{border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 8px;font-size:12px;cursor:pointer;display:inline-flex;align-items:center;gap:5px}',
      '.cp-chip-on{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.cp-chip-excluded{text-decoration:line-through;color:var(--dsw-alias-label-tertiary)}',
      '.cp-msg{border-radius:6px;padding:6px 8px;font-size:12px;line-height:17px;white-space:pre-wrap;word-break:break-word}',
      '.cp-msg-ok{background:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-bg-base)}',
      '.cp-msg-err{background:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-bg-base)}',
      '.cp-msg-warn{background:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-bg-base)}',
      '.cp-history{display:flex;flex-direction:column;gap:4px;max-height:240px;overflow:auto}',
      '.cp-history-row{display:flex;gap:8px;font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;border-bottom:0.5px solid var(--dsw-alias-border-l1);padding-bottom:3px}',
      '.cp-trace{font-size:12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--dsw-alias-label-secondary);display:flex;flex-direction:column;gap:2px}',
      '.cp-inline{display:flex;align-items:center;gap:6px;flex-wrap:wrap}',
    ].join('')

    const CSS_TAG = '@deepseek-ai/dsh-cline-pass/client.css'
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(CSS_TAG) + ']') === null) {
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-cline-pass'
      tag.dataset.pluginCss = CSS_TAG
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    //#endregion

    //#region copy

    const ZH = {
      title: 'Cline Pass',
      keyOk: 'API Key 已配置',
      keyMissing: '尚未配置 API Key',
      keyValue: 'API Key',
      keyPlaceholder: 'sk_…',
      save: '保存',
      saveTest: '保存并测试',
      test: '测试',
      remove: '删除',
      accounts: '账号',
      accountMode: '账号模式',
      modeSingle: '单账号',
      modeRoundrobin: '轮询',
      active: '当前账号',
      addAccount: '添加',
      accountName: '账号名',
      models: '订阅模型',
      modelsCount: '{n} 个模型',
      noChannels: '未探测渠道',
      pinned: '已钉住',
      auto: '自动路由',
      autoSetup: '一键配置',
      autoSetupHint: '探测 → 校验全部渠道 → 钉住可用渠道 → 真实请求验证',
      probe: '探测',
      validate: '校验',
      testPin: '测试',
      reset: '恢复自动',
      refresh: '刷新',
      channels: '渠道（点选＝钉住顺序，⊘＝排除）',
      history: '最近请求',
      noHistory: '暂无记录。',
      busy: '处理中…',
      notReady: '先配置 API Key。',
      settingsUnavailable: '设置服务不可用，改动无法保存。',
      panelUnavailable: '浏览器通道不可用。',
      retry: '重试',
      autoDone: '已钉住 {n} 个渠道。',
      autoKept: '无可用渠道，保持自动路由。',
    }
    const EN = {
      title: 'Cline Pass',
      keyOk: 'API key configured',
      keyMissing: 'No API key',
      keyValue: 'API key',
      keyPlaceholder: 'sk_…',
      save: 'Save',
      saveTest: 'Save and test',
      test: 'Test',
      remove: 'Remove',
      accounts: 'Accounts',
      accountMode: 'Mode',
      modeSingle: 'Single',
      modeRoundrobin: 'Round robin',
      active: 'Active',
      addAccount: 'Add',
      accountName: 'Name',
      models: 'Models',
      modelsCount: '{n} model(s)',
      noChannels: 'No channels probed',
      pinned: 'Pinned',
      auto: 'Auto',
      autoSetup: 'Auto-configure',
      autoSetupHint: 'probe → validate every channel → pin the healthy ones → verify with a real request',
      probe: 'Probe',
      validate: 'Validate',
      testPin: 'Test',
      reset: 'Back to auto',
      refresh: 'Refresh',
      channels: 'Channels (click = pin order, ⊘ = exclude)',
      history: 'Recent requests',
      noHistory: 'Nothing recorded.',
      busy: 'Working…',
      notReady: 'Configure the API key first.',
      settingsUnavailable: 'Settings are read-only; changes will not persist.',
      panelUnavailable: 'The browser channel is unavailable.',
      retry: 'Retry',
      autoDone: 'Pinned {n} channel(s).',
      autoKept: 'No usable channel; kept automatic routing.',
    }

    //#endregion

    //#region store

    /**
     * A minimal uSES-safe external store.
     *
     * `getSnapshot` keeps returning the same reference until `set` replaces it,
     * which is what the slot hook contract requires.
     */
    function createStore(initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set: (next) => {
          value = next
          for (const listener of [...listeners]) listener()
        },
      }
    }

    //#endregion

    //#region helpers

    /** Format a byte-free duration for display. */
    function ms(value) {
      const n = Number(value ?? 0)
      if (!Number.isFinite(n) || n <= 0) return '-'
      return n >= 1000 ? (n / 1000).toFixed(1) + 's' : Math.round(n) + 'ms'
    }

    /** Format a timestamp as local time, or '-' when absent. */
    function time(value) {
      const n = Number(value ?? 0)
      if (!Number.isFinite(n) || n <= 0) return '-'
      try { return new Date(n).toLocaleTimeString() } catch { return '-' }
    }

    /** Colour a channel verdict. */
    function verdictColor(status) {
      if (status === 'ok') return 'var(--dsw-alias-state-success-primary)'
      if (status === 'limited') return 'var(--dsw-alias-state-warn-primary)'
      if (status === 'unknown') return 'var(--dsw-alias-label-tertiary)'
      return 'var(--dsw-alias-state-error-primary)'
    }

    /** Interpolate `{n}`-style placeholders. */
    function fill(template, params) {
      return String(template).replace(/\{(\w+)\}/g, (whole, key) => (params?.[key] === undefined ? whole : String(params[key])))
    }

    //#endregion

    //#region controller

    /**
     * The panel's state and actions.
     *
     * One instance is shared by every registration this bundle makes, so the
     * Settings page, the Plugins card and the Models card all agree.
     */
    class PanelController {
      constructor(ctx) {
        this.ctx = ctx
        this.store = createStore({ status: 'loading', error: null, data: null, busy: null, notice: null, action: null })
        this.disposed = false
        this.localeDispose = undefined
        this.unsubscribe = undefined
        this.t = this.makeTranslate()
      }

      /**
       * Bind this panel's copy to the active locale.
       *
       * The dictionaries register as soon as the locale service exists, but the
       * ACTIVE locale is read on every call rather than captured here: this
       * plugin does not declare `locale` as a dependency, so that service can
       * legitimately activate after this one, and a value captured at
       * construction would freeze the panel on its fallback language.
       */
      makeTranslate() {
        const locale = this.ctx.get('locale')
        if (locale !== undefined) {
          try { locale.register(NS, 'zh', ZH) } catch { /* a duplicate registration is harmless */ }
          try { locale.register(NS, 'en', EN) } catch { /* see above */ }
          this.localeDispose = locale.subscribe(() => this.publish())
        }
        return (key, params) => {
          let active
          try { active = this.ctx.get('locale')?.getLocale?.()?.active } catch { /* keep the default */ }
          const dict = active === 'en' ? EN : ZH
          return fill(dict[key] ?? EN[key] ?? key, params)
        }
      }

      /** Stop observing. */
      dispose() {
        this.disposed = true
        this.unsubscribe?.()
        this.localeDispose?.()
      }

      /** The face injected into a slot registration. */
      inject() {
        const controller = this
        return {
          hooks: { clinePass: controller.store },
          refresh: () => controller.refresh(),
          setKey: (ref, value) => controller.setKey(ref, value),
          testKey: (ref, value) => controller.testKey(ref, value),
          saveAndTest: (ref, value) => controller.saveAndTest(ref, value),
          addAccount: (payload) => controller.addAccount(payload),
          removeAccount: (name) => controller.removeAccount(name),
          setAccountMode: (patch) => controller.setAccountMode(patch),
          pinModel: (payload) => controller.pinModel(payload),
          setupModel: (model) => controller.setupModel(model),
          probeModel: (model) => controller.probeModel(model),
          validateModel: (model) => controller.validateModel(model),
          testModel: (model) => controller.testModel(model),
          resetModel: (model) => controller.resetModel(model),
          refreshModels: () => controller.refreshModels(),
          loadHistory: (limit) => controller.loadHistory(limit),
          clearNotice: () => controller.clearNotice(),
        }
      }

      /** Publish the current snapshot. */
      publish(patch = {}) {
        if (this.disposed) return
        this.store.set({ ...this.store.getSnapshot(), ...patch })
      }

      /**
       * One panel round trip; rejects with the host's own diagnostic.
       *
       * A plain same-origin `fetch` to the exact route Connection already
       * guards: the session cookie rides along automatically, and the host
       * answers every action as `{ ok, value? , error? }` so one code path
       * covers success and refusal.
       */
      async call(endpoint, payload) {
        if (this.ctx.get('connection') === undefined) throw new Error(this.t('panelUnavailable'))
        let response
        try {
          response = await fetch(PANEL_PATH, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endpoint, payload: payload ?? {} }),
          })
        } catch (error) {
          throw new Error(`${this.t('panelUnavailable')} (${String(error?.message ?? error)})`)
        }
        if (!response.ok) throw new Error(`the Cline Pass panel route answered HTTP ${response.status}`)
        const result = await response.json().catch(() => null)
        if (result?.ok === true) return result.value
        throw new Error(result?.error?.message ?? 'the Cline Pass panel refused this request')
      }

      /** Run one action with busy/notice bookkeeping. */
      async run(label, action) {
        this.publish({ busy: label, notice: null })
        try {
          const value = await action()
          this.publish({ busy: null, error: null, action: value ?? this.store.getSnapshot().action })
          return value
        } catch (error) {
          this.publish({ busy: null, error: String(error?.message ?? error), action: null })
          return undefined
        }
      }

      /** Merge a fresh host state into the snapshot. */
      applyState(value) {
        const data = value?.accounts === undefined && value?.provider === undefined ? this.store.getSnapshot().data : value
        if (data !== undefined && data !== null && data.provider !== undefined) this.publish({ data, status: 'ready', error: null })
        return value
      }

      /** Re-read the whole panel state. */
      async refresh() {
        try {
          const value = await this.call('state', {})
          this.applyState(value)
        } catch (error) {
          this.publish({ status: 'error', error: String(error?.message ?? error) })
        }
      }

      /** Clear the transient notice. */
      clearNotice() {
        this.publish({ notice: null, error: null, action: null })
      }

      /** Store the key. The status line and masked hint are the confirmation. */
      async setKey(ref, value) {
        const result = await this.run('key', async () => await this.call('key.set', { ref, value }))
        if (result !== undefined) this.applyState(result)
      }

      /** Test a key without storing it. */
      async testKey(ref, value) {
        return await this.run('key', async () => {
          const result = await this.call('key.test', { ref, value })
          this.publish({
            notice: result.ok === true
              ? { kind: 'ok', text: `${result.label} · ok · ${ms(result.ms)}` }
              : { kind: 'err', text: `${result.label} · ${result.error || 'failed'}` },
          })
          return result
        })
      }

      /** Save a key and test it in one gesture. */
      async saveAndTest(ref, value) {
        const probe = await this.testKey(ref, value)
        if (probe?.ok === true) await this.setKey(ref, value)
      }

      /** Add or update an account. */
      async addAccount(payload) {
        const result = await this.run('account', async () => await this.call('account.add', payload))
        if (result !== undefined) {
          this.applyState(result)
          this.publish({ notice: { kind: 'ok', text: `${result.name} · ${result.apiKeyEnv}${result.keyStored ? ' · key stored' : ''}` } })
        }
      }

      /** Remove an account. */
      async removeAccount(name) {
        const result = await this.run('account', async () => await this.call('account.remove', { name }))
        if (result !== undefined) this.applyState(result)
      }

      /** Switch account mode or the active account. */
      async setAccountMode(patch) {
        const result = await this.run('account', async () => await this.call('account.mode', patch))
        if (result !== undefined) this.applyState(result)
      }

      /** Persist one model's pin. */
      async pinModel(payload) {
        const result = await this.run('pin', async () => await this.call('model.pin', payload))
        if (result !== undefined) this.applyState(result)
        return result
      }

      /** Probe one model and surface the discovered channels. */
      async probeModel(model) {
        const result = await this.run('probe', async () => await this.call('model.probe', { model }))
        await this.refresh()
        if (result !== undefined) {
          this.publish({
            action: { kind: 'probe', model, data: result.result },
            notice: result.result?.ok === true
              ? { kind: 'ok', text: `${model} · ${result.result.pipeline || 'pipeline?'} · ${(result.result.upstreams ?? []).length} channel(s)` }
              : { kind: 'err', text: `${model} · ${result.result?.error || 'probe failed'}` },
          })
        }
        return result
      }

      /** Validate every known channel of one model. */
      async validateModel(model) {
        const result = await this.run('validate', async () => await this.call('model.validate', { model }))
        if (result !== undefined) {
          this.applyState(result)
          const summary = result.summary ?? {}
          this.publish({
            action: { kind: 'validate', model, data: result },
            notice: {
              kind: (summary.ok ?? 0) > 0 ? 'ok' : 'warn',
              text: `${model} · available=${summary.ok ?? 0} rate-limited=${summary.limited ?? 0} not-pinnable=${summary.bad ?? 0} auth-failed=${summary.auth ?? 0}`,
            },
          })
        }
        return result
      }

      /** Try the stored (or a supplied) pin once, without persisting it. */
      async testModel(model, upstreams) {
        const result = await this.run('test', async () => await this.call('model.test', { model, upstreams }))
        await this.refresh()
        if (result !== undefined) {
          this.publish({
            action: { kind: 'test', model, data: result },
            notice: result.ok === true
              ? { kind: 'ok', text: `${model} · served by ${result.actual || '(auto)'} · ${ms(result.ms)}` }
              : { kind: 'err', text: `${model} · ${result.error || 'failed'}` },
          })
        }
        return result
      }

      /** The one-click path for one model. */
      async setupModel(model) {
        this.publish({ busy: 'setup:' + model, notice: null, error: null })
        try {
          const result = await this.call('setup.auto', { model })
          const pinned = (result?.pinned ?? []).length
          this.publish({
            busy: null,
            action: { kind: 'setup', model, data: result },
            notice: result?.ok === true
              ? { kind: 'ok', text: fill(this.t('autoDone'), { n: pinned }) + (result.actual ? ` (${result.actual})` : '') }
              : { kind: 'warn', text: `${model} · ${result?.error || this.t('autoKept')}` },
          })
          return result
        } catch (error) {
          this.publish({ busy: null, error: String(error?.message ?? error) })
          return undefined
        } finally {
          await this.refresh()
        }
      }

      /** Return one model to automatic routing. */
      async resetModel(model) {
        const result = await this.pinModel({ model, upstreams: [], exclude: [], sort: 'none' })
        if (result !== undefined) this.publish({ notice: { kind: 'ok', text: `${model} · ${this.t('auto')}` } })
        return result
      }

      /** Rescan the official subscription list. */
      async refreshModels() {
        const result = await this.run('models', async () => await this.call('models.refresh', {}))
        if (result !== undefined) {
          this.applyState(result)
          this.publish({ notice: { kind: 'ok', text: `+${(result.added ?? []).length} · ${(result.sources ?? []).join(', ')}` } })
        }
        return result
      }

      /** Load the in-process request history. */
      async loadHistory(limit) {
        return await this.run('history', async () => {
          const result = await this.call('history', { limit: limit ?? 25 })
          this.publish({ action: { kind: 'history', data: result } })
          return result
        })
      }
    }

    //#endregion

    //#region components

    /** One inline notice line. */
    function Notice(props) {
      if (props.notice === undefined || props.notice === null) return null
      const kind = props.notice.kind === 'ok' ? 'cp-msg-ok' : props.notice.kind === 'warn' ? 'cp-msg-warn' : 'cp-msg-err'
      return h('div', { className: `cp-msg ${kind}`, role: 'status' }, props.notice.text)
    }

    /** A dependency-free coloured dot. */
    function Dot(props) {
      return h('span', { className: 'cp-dot', style: { background: props.color }, title: props.title })
    }

    /** The API-key field, shared by the panel and the Models card. */
    function KeyField(props) {
      const { t, account, disabled, onSave, onTest, onSaveTest, busy } = props
      const [value, setValue] = React.useState('')
      const entered = value.trim().length > 0
      return h('div', { className: 'cp-card' }, [
        h('div', { key: 'row', className: 'cp-row' }, [
          h('span', { key: 'l', className: 'cp-muted' }, t('keyValue')),
          h('input', {
            key: 'input',
            className: 'cp-input cp-grow',
            type: 'password',
            autoComplete: 'off',
            spellCheck: false,
            value,
            placeholder: t('keyPlaceholder'),
            'aria-label': t('keyValue'),
            disabled,
            onChange: (event) => setValue(event.target.value),
          }),
          h('button', {
            key: 'save', type: 'button', className: 'cp-btn cp-btn-primary',
            disabled: disabled || !entered,
            onClick: () => { onSaveTest(value.trim()); setValue('') },
          }, t('saveTest')),
          h('button', {
            key: 'test', type: 'button', className: 'cp-btn',
            disabled: disabled || !entered,
            onClick: () => onTest(value.trim()),
          }, t('test')),
          h('button', {
            key: 'saveOnly', type: 'button', className: 'cp-btn',
            disabled: disabled || !entered,
            onClick: () => { onSave(value.trim()); setValue('') },
          }, t('save')),
          busy ? h('span', { key: 'b', className: 'cp-muted' }, t('busy')) : null,
        ]),
      ])
    }

    /** The channel chooser for one model. */
    function ChannelPicker(props) {
      const { t, model, disabled, onPin } = props
      if (model.upstreams.length === 0) return h('div', { className: 'cp-muted' }, t('noChannels'))
      const verdicts = new Map((model.upstreamStatus ?? []).map((entry) => [entry.upstream, entry]))
      return h('div', { className: 'cp-row' }, [
        h('span', { key: 'label', className: 'cp-muted' }, t('channels')),
        h('span', { key: 'chips', className: 'cp-chips' }, model.upstreams.map((upstream) => {
          const pinned = model.pinned.includes(upstream)
          const excluded = model.excluded.includes(upstream)
          const verdict = verdicts.get(upstream)
          const detail = verdict === undefined
            ? ''
            : ` · ${VERDICT[verdict.status] ?? verdict.status}${verdict.note ? `\n${verdict.note}` : ''}`
          return h('span', { key: upstream, className: `cp-chip${pinned ? ' cp-chip-on' : ''}${excluded ? ' cp-chip-excluded' : ''}` }, [
            h('span', {
              key: 'pin',
              role: 'button',
              tabIndex: 0,
              title: `${upstream}${detail}`,
              onClick: () => {
                if (disabled) return
                const next = pinned ? model.pinned.filter((name) => name !== upstream) : [...model.pinned, upstream]
                onPin({ model: model.id, upstreams: next })
              },
            }, [
              h('span', { key: 'dot', style: { marginRight: 5 } }, h(Dot, { color: verdictColor(verdict?.status ?? 'unknown'), title: VERDICT[verdict?.status ?? 'unknown'] })),
              upstream,
            ]),
            h('span', {
              key: 'ex',
              role: 'button',
              tabIndex: 0,
              title: excluded ? 'un-exclude' : 'exclude',
              onClick: () => {
                if (disabled) return
                const next = excluded ? model.excluded.filter((name) => name !== upstream) : [...model.excluded, upstream]
                onPin({ model: model.id, exclude: next })
              },
            }, '⊘'),
          ])
        })),
      ])
    }

    /**
     * One model row.
     *
     * The default view is deliberately just identity plus the one action that
     * matters, so a page of models stays readable; the finer pin actions and the
     * channel list live behind the expander.
     */
    function ModelRow(props) {
      const { t, model, disabled, busy, actions } = props
      const [open, setOpen] = React.useState(false)
      const working = busy === 'setup:' + model.id
      const pinnedLabel = model.pinned.length === 0 ? t('auto') : model.pinned.join(' › ')
      const action = (key, label, run) => h('button', {
        key, type: 'button', className: 'cp-btn', disabled, onClick: () => run(model.id),
      }, label)
      return h('div', { className: 'cp-model' }, [
        h('div', { key: 'head', className: 'cp-row' }, [
          h('span', { key: 'name', className: 'cp-mono cp-grow' }, model.id),
          h('span', { key: 'pin', className: 'cp-muted cp-mono' }, `${t('pinned')}: ${pinnedLabel}`),
          h('button', {
            key: 'auto', type: 'button', className: 'cp-btn cp-btn-primary',
            disabled, title: t('autoSetupHint'), onClick: () => actions.setupModel(model.id),
          }, working ? t('busy') : t('autoSetup')),
          h('button', {
            key: 'more', type: 'button', className: 'cp-btn', title: t('channels'),
            onClick: () => setOpen(!open),
          }, open ? '▾' : '▸'),
        ]),
        open ? h('div', { key: 'detail', className: 'cp-panel' }, [
          h('div', { key: 'actions', className: 'cp-row' }, [
            action('probe', t('probe'), actions.probeModel),
            action('validate', t('validate'), actions.validateModel),
            action('test', t('testPin'), actions.testModel),
            action('reset', t('reset'), actions.resetModel),
          ]),
          model.upstreams.length > 0
            ? h(ChannelPicker, { key: 'channels', t, model, disabled, onPin: (payload) => actions.pinModel(payload) })
            : h('div', { key: 'none', className: 'cp-muted' }, t('noChannels')),
        ]) : null,
      ])
    }

    /** The accounts card. */
    function AccountsCard(props) {
      const { t, data, disabled, actions } = props
      const [name, setName] = React.useState('')
      const [key, setKey] = React.useState('')
      const primary = data.accounts[0]
      return h('div', { className: 'cp-card' }, [
        h('div', { key: 'title', className: 'cp-card-title' }, [h('span', { key: 'l' }, t('accounts'))]),
        primary !== undefined
          ? h(KeyField, {
            key: 'key',
            t,
            account: primary,
            disabled,
            busy: false,
            onSave: (value) => actions.setKey(primary.apiKeyEnv, value),
            onTest: (value) => actions.testKey(primary.apiKeyEnv, value),
            onSaveTest: (value) => actions.saveAndTest(primary.apiKeyEnv, value),
          })
          : null,
        h('div', { key: 'list', className: 'cp-table' }, data.accounts.map((account) => h('div', { key: account.key, className: 'cp-account' }, [
          h('div', { key: 'row', className: 'cp-row' }, [
            h(Dot, { key: 'd', color: account.keyConfigured ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)', title: account.keyConfigured ? t('keyOk') : t('keyMissing') }),
            h('span', { key: 'n', className: 'cp-grow' }, account.displayName),
            h('span', { key: 'k', className: 'cp-muted cp-mono' }, account.keyConfigured ? account.keyHint : '—'),
            h('button', {
              key: 't', type: 'button', className: 'cp-btn', disabled,
              onClick: () => actions.testKey(account.apiKeyEnv, ''),
            }, t('test')),
            h('button', {
              key: 'x', type: 'button', className: 'cp-btn cp-btn-danger',
              disabled: disabled || data.accounts.length <= 1,
              onClick: () => actions.removeAccount(account.key),
            }, t('remove')),
          ]),
        ]))),
        // A pool of one account needs none of this; it appears with the second.
        data.accounts.length <= 1 ? null : h('div', { key: 'mode', className: 'cp-row' }, [
          h('span', { key: 'l', className: 'cp-muted' }, t('accountMode')),
          h('select', {
            key: 's', className: 'cp-select', value: data.accountMode, disabled,
            onChange: (event) => actions.setAccountMode({ mode: event.target.value }),
          }, [
            h('option', { key: 'single', value: 'single' }, t('modeSingle')),
            h('option', { key: 'rr', value: 'roundrobin' }, t('modeRoundrobin')),
          ]),
          h('span', { key: 'al', className: 'cp-muted' }, t('active')),
          h('select', {
            key: 'as', className: 'cp-select', value: data.activeAccount, disabled,
            onChange: (event) => actions.setAccountMode({ active: event.target.value }),
          }, [h('option', { key: '', value: '' }, '(first enabled)')].concat(
            data.accounts.map((account) => h('option', { key: account.key, value: account.key }, account.key)),
          )),
        ]),
        h('div', { key: 'add', className: 'cp-row' }, [
          h('input', {
            key: 'n', className: 'cp-input', placeholder: t('accountName'), value: name, disabled,
            'aria-label': t('accountName'),
            onChange: (event) => setName(event.target.value),
          }),
          h('input', {
            key: 'k', className: 'cp-input cp-grow', type: 'password', autoComplete: 'off',
            placeholder: t('keyPlaceholder'), value: key, disabled,
            'aria-label': t('keyValue'),
            onChange: (event) => setKey(event.target.value),
          }),
          h('button', {
            key: 'add', type: 'button', className: 'cp-btn',
            disabled: disabled || name.trim().length === 0,
            onClick: () => { actions.addAccount({ name: name.trim(), key: key.trim() }); setName(''); setKey('') },
          }, t('addAccount')),
        ]),
      ])
    }

    /** The models card. */
    function ModelsCard(props) {
      const { t, data, disabled, busy, actions } = props
      return h('div', { className: 'cp-card' }, [
        h('div', { key: 'title', className: 'cp-card-title' }, [
          h('span', { key: 'l' }, `${t('models')} · ${fill(t('modelsCount'), { n: data.models.length })}`),
          h('button', {
            key: 'r', type: 'button', className: 'cp-btn', disabled,
            onClick: () => actions.refreshModels(),
          }, t('refresh')),
        ]),
        h('div', { key: 'rows', className: 'cp-table' }, data.models.map((model) => h(ModelRow, {
          key: model.id, t, model, disabled, busy, actions,
        }))),
      ])
    }

    /** The request-history body, rendered inside the panel's fold-away section. */
    function HistoryCard(props) {
      const { t, entries, disabled, actions } = props
      return h('div', { className: 'cp-panel' }, [
        h('div', { key: 'bar', className: 'cp-row' }, [
          h('button', { key: 'r', type: 'button', className: 'cp-btn', disabled, onClick: () => actions.loadHistory(25) }, t('refresh')),
        ]),
        entries === null
          ? h('div', { key: 'empty', className: 'cp-muted' }, t('noHistory'))
          : h('div', { key: 'rows', className: 'cp-history' }, entries.map((entry, index) => h('div', { key: `${entry.ts}-${index}`, className: 'cp-history-row' }, [
            h('span', { key: 'm', className: 'cp-grow' }, entry.model),
            h('span', { key: 'p' }, entry.provider || '(auto)'),
            h('span', { key: 'ms', className: 'cp-muted' }, ms(entry.ms)),
            entry.error ? h('span', { key: 'e', style: { color: 'var(--dsw-alias-state-error-primary)' } }, entry.error) : null,
          ]))),
      ])
    }

    /** The full panel: what the Settings page and the Plugins card render. */
    function Panel(props) {
      const t = props.t
      const state = props.useClinePass((snapshot) => snapshot)
      const [history, setHistory] = React.useState(null)

      // Read once on mount, while there is nothing to render. The dependency is
      // the loaded data itself, not the status: a failed read leaves `data`
      // null, so the effect does not re-run in a loop, and a successful one
      // stops asking. A later failure keeps the last good snapshot on screen.
      React.useEffect(() => {
        if (state.data === null) props.refresh()
      }, [state.data])

      React.useEffect(() => {
        if (state.action?.kind === 'history') setHistory(state.action.data.entries ?? [])
      }, [state.action])

      const actions = {
        refresh: props.refresh,
        setKey: props.setKey,
        testKey: props.testKey,
        saveAndTest: props.saveAndTest,
        addAccount: props.addAccount,
        removeAccount: props.removeAccount,
        setAccountMode: props.setAccountMode,
        pinModel: props.pinModel,
        setupModel: props.setupModel,
        probeModel: props.probeModel,
        validateModel: props.validateModel,
        testModel: props.testModel,
        resetModel: props.resetModel,
        refreshModels: props.refreshModels,
        loadHistory: async (limit) => {
          const result = await props.loadHistory(limit)
          if (result !== undefined) setHistory(result.entries ?? [])
        },
      }

      const data = state.data
      const disabled = state.busy !== null || (data !== null && data.settingsAvailable === false)
      const ready = data?.ready === true

      return h('div', { className: 'cp-panel' }, [
        h('h2', { key: 'title', className: 'cp-title' }, t('title')),
        // One status line replaces the old route/baseURL block: the endpoint is
        // not something a user sets, so showing it was pure noise.
        h('div', { key: 'status', className: 'cp-row cp-muted' }, [
          h(Dot, { key: 'd', color: ready ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)', title: ready ? t('keyOk') : t('keyMissing') }),
          h('span', { key: 's' }, ready ? t('keyOk') : t('keyMissing')),
        ]),
        data !== null && data.settingsAvailable === false
          ? h('div', { key: 'unavailable', className: 'cp-msg cp-msg-warn' }, t('settingsUnavailable'))
          : null,
        state.error !== null ? h('div', { key: 'err', className: 'cp-msg cp-msg-err' }, state.error) : null,
        h(Notice, { key: 'notice', notice: state.notice }),
        state.status === 'loading' && data === null
          ? h('div', { key: 'loading', className: 'cp-muted' }, t('busy'))
          : null,
        data === null ? null : h(AccountsCard, { key: 'accounts', t, data, disabled, actions }),
        data === null ? null : (ready
          ? h(ModelsCard, { key: 'models', t, data, disabled, busy: state.busy, actions })
          : h('div', { key: 'notready', className: 'cp-msg cp-msg-warn' }, t('notReady'))),
        // Diagnostic detail, so it stays folded away until asked for.
        h('details', { key: 'history', className: 'cp-card' }, [
          h('summary', { key: 'sum', className: 'cp-card-title' }, t('history')),
          h(HistoryCard, { key: 'body', t, entries: history, disabled: state.busy !== null, actions }),
        ]),
      ])
    }

    /** The compact card the Models page renders for this provider. */
    function QuickCard(props) {
      const t = props.t
      const state = props.useClinePass((snapshot) => snapshot)
      React.useEffect(() => {
        if (state.data === null) props.refresh()
      }, [state.data])
      const data = state.data
      const account = data?.accounts?.[0]
      return h('div', { className: 'cp-panel' }, [
        h('div', { key: 'head', className: 'cp-row' }, [
          h(Dot, { key: 'd', color: data?.ready === true ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-warn-primary)', title: data?.ready === true ? t('keyOk') : t('keyMissing') }),
          h('span', { key: 'n', className: 'cp-grow' }, data?.ready === true ? t('keyOk') : t('keyMissing')),
        ]),
        account === undefined ? null : h(KeyField, {
          key: 'key',
          t,
          account,
          disabled: state.busy !== null || data?.settingsAvailable === false,
          busy: state.busy !== null,
          onSave: (value) => props.setKey(account.apiKeyEnv, value),
          onTest: (value) => props.testKey(account.apiKeyEnv, value),
          onSaveTest: (value) => props.saveAndTest(account.apiKeyEnv, value),
        }),
        h(Notice, { key: 'notice', notice: state.notice }),
        state.error !== null ? h('div', { key: 'err', className: 'cp-msg cp-msg-err' }, state.error) : null,
        state.data === null
          ? h('div', { key: 'retry', className: 'cp-row' }, [
            h('button', { key: 'b', type: 'button', className: 'cp-btn', onClick: () => props.refresh() }, t('retry')),
          ])
          : null,
      ])
    }

    //#endregion

    //#region plugin

    /** The slot registry and the browser RPC transport. */
    const inject = ['slots', 'connection']

    /**
     * Mount the Cline Pass configuration surface.
     * @param ctx - browser plugin context.
     */
    function apply(ctx) {
      const controller = new PanelController(ctx)
      ctx.effect(() => () => controller.dispose(), 'cline-pass: panel controller')
      const face = () => controller.inject()
      /**
       * The translate function every registration and component uses.
       *
       * The shared locale registry is preferred, but a namespace lookup that
       * resolves nothing ECHOES THE KEY BACK instead of throwing, so a bare
       * `try/catch` around it is not enough — an unresolved key would render as
       * `keyMissing` rather than as copy. Any result that merely repeats the
       * key therefore falls through to this bundle's own dictionary, which is
       * resolved against the active locale and always has the key.
       */
      const translate = (key, params) => {
        const locale = ctx.get('locale')
        if (locale !== undefined) {
          try {
            const translated = locale.bind(NS)(key, params)
            if (typeof translated === 'string' && translated !== key) return translated
          } catch { /* fall through to the bundled dictionary */ }
        }
        return controller.t(key, params)
      }

      const renderPanel = (props) => h(Panel, { ...props, ...face, t: translate })
      const renderQuick = (props) => h(QuickCard, { ...props, ...face, t: translate })

      // 1. A dedicated settings page: the full configuration surface.
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: NS,
        order: 12,
        label: () => translate('title'),
        locale: NS,
        inject: face,
      }, renderPanel))

      // 2. A card on the Plugins page, which already enumerates this
      //    namespace, so the panel is also where users look for plugin config.
      ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
        name: 'settings.plugin.item',
        key: NS,
        locale: NS,
        inject: face,
      }, renderPanel))

      // 3. A compact key card on the Models page, right where the missing key
      //    for this route is reported.
      ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
        name: 'settings.models.provider-card',
        key: NS,
        locale: NS,
        inject: face,
      }, renderQuick))

      // The first read is lazy (each component asks for it), because the RPC
      // transport only exists once Connection has activated.
      void controller.refresh()
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
