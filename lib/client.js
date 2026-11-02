/**
 * dsh-bili —— 客户端半边：DSH「设置」里的 **B站账号** section。
 *
 * 为什么是手写的、没有构建链（与 dsh-video 同一种做法）：
 *   宿主只加载 lib/client.js 这个**已经能跑**的文件（package.json 的 exports['./client']
 *   + dsh.client.platform='web'），它不跑我们的构建脚本。所以这里不能有 JSX / TypeScript /
 *   import 语句 —— 只有 require('react') 和 h()。代价是这个文件长得不像源码，
 *   好处是装上去就能用，没有 build 步骤会坏。
 *
 * ⚠️ loader id **必须等于 package.json 的 name**（scoped 包就是带 scope 的全名）：
 *   宿主按**包名**激活 web entry，而 __ModuleLoader__.load({ id }) 是它用来认领的键。
 *   写短名（曾写成 "dsh-bili"）时两者的对不上 → 宿主判定「entry did not activate」，
 *   症状是启动时 `import failed` + `web boot: 1 entry did not activate` → renderer recovery
 *   连试 3 次 exhausted，整个宿主都起不来（踩过一次，别再踩）。
 *   对照：dsh-voice-call / dsh-video-zxk / dsh-pet / dsh-lanpangzi 的 id 都等于各自包名。
 *
 * 数据流：section ⇄ 同源 fetch /dsh-bili/api/kernel/* ⇄ lib/settings-api.js ⇄ core/config.js
 *   → 宿主侧每次调用都重新读配置文件，所以**保存即生效，不用重启**。
 *
 * 红线：这个界面**永远不回显 cookie**。粘贴框只进不出（type=password，保存成功即清空），
 *   状态区只显示"齐不齐"。凭据值出现在 DOM 里 = 一次截图/一次 DevTools 就泄漏了。
 */
// 幂等装载：宿主 HMR 会把同一个 client bundle 再执行一遍，而 __ModuleLoader__ 对重复的 id
// 会抛 uncaught（client-modules: duplicate factory registration）。对已发布的插件，
// 「同一页面只装一次」就是正确语义；开发时要拿新代码，刷新页面即可。
if (window.__dshBiliClientLoaded !== true) {
  window.__dshBiliClientLoaded = true;
  window.__ModuleLoader__.load({
    // 必须等于 package.json 的 name（见文件头）；不等于 → 宿主判「entry did not activate」
    id: "@owl-zxk/dsh-bili",
    factory: (require) => {
      const module = { exports: {} };
      const exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

      const React = require("react");
      const { createElement: h, useCallback, useEffect, useState } = React;

      // 中间那层 kernel 是命名空间隔离：同源的另一个插件占了 /dsh-bili/api 下的 status 与 settings，
      // 而宿主对重复 exact 路径会丢弃后注册的一方（我们）——真机症状是 401 空 body。不跟它抢。
      const API = "/dsh-bili/api/kernel";
      // 自主运营层「她」：另开一层前缀，理由同 kernel —— 宿主对重复 exact 路由会丢弃后注册者。
      const SELF_API = "/dsh-bili/api/self";
      const CSS_TAG = "dsh-bili/section.css";
      const CSS = [
        ".dbw{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:6px}",
        ".dbw-title{margin:0;font-size:16px;font-weight:500;line-height:24px}",
        ".dbw-intro{color:var(--dsw-alias-label-tertiary);margin:0 0 4px;font-size:13px;line-height:20px}",
        ".dbw-group{margin-top:14px;font-size:13px;font-weight:600;line-height:20px}",
        ".dbw-rows{display:flex;flex-direction:column}",
        ".dbw-row{display:flex;justify-content:space-between;align-items:flex-start;gap:12px 20px;padding:10px 0;border-bottom:.5px solid var(--dsw-alias-border-l2);flex-wrap:wrap}",
        ".dbw-row:last-child{border-bottom:none}",
        ".dbw-row>div:first-child{flex:1;min-width:190px}",
        ".dbw-label{font-size:13px;line-height:19px}",
        ".dbw-hint{color:var(--dsw-alias-label-tertiary);margin-top:3px;font-size:11.5px;line-height:17px}",
        ".dbw-input{background:transparent;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12.5px;height:28px;padding:0 8px;min-width:150px;outline:none}",
        ".dbw-input:focus-visible{border-color:var(--dsw-alias-brand-primary)}",
        ".dbw-input.dbw-wide{min-width:300px}",
        ".dbw-stack{display:flex;flex-direction:column;gap:6px;align-items:flex-start}",
        ".dbw-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin-top:14px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}",
        ".dbw-btn{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary-foreground,#fff);border:none;border-radius:6px;font-size:12.5px;height:30px;padding:0 12px;cursor:pointer}",
        ".dbw-btn:disabled{opacity:.5;cursor:default}",
        ".dbw-btn2{background:transparent;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}",
        ".dbw-err{margin-top:10px;font-size:12.5px;line-height:18px;color:#ff5a5f;white-space:pre-wrap}",
        ".dbw-out{margin-top:10px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap}",
        ".dbw-dirty{color:#ffb020;font-size:12.5px;margin-left:4px}",
        ".dbw-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;word-break:break-all}",
        ".dbw-tabs{display:flex;gap:2px;border-bottom:.5px solid var(--dsw-alias-border-l2);margin:0 0 8px}",
        ".dbw-tab{background:transparent;border:none;border-bottom:2px solid transparent;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;padding:7px 12px;cursor:pointer}",
        ".dbw-tab:hover{color:var(--dsw-alias-label-primary)}",
        ".dbw-tab-active{color:var(--dsw-alias-label-primary);border-bottom-color:var(--dsw-alias-brand-primary);font-weight:600}",
        ".dbw-ok{color:#2eb872}",
        ".dbw-bad{color:#ff5a5f}",
      ].join("");

      // 额度口径已改成 token（INTERFACE §11）：原来的「每小时/每天读、写次数」不再参与判定，
      // 界面上也拿掉 —— 摆着不改的输入框比没有更糟。留下的只有 token 预算与三个间隔。
      // 输入框是文本型（type=text + inputMode=numeric）：number 型浏览器根本不让敲 "200K"。
      // 换算在后端做（settings-api.js 的 parseTokenAmount），界面只负责显示成好读的单位。
      const BUDGET_FIELDS = [
        { key: "tokenHourly", label: "每小时 token 预算" },
        { key: "tokenDaily", label: "每天 token 预算" },
      ];
      const BUDGET_HINT = "支持 200K / 1.5M / 8000000 这类写法；保存后按整数存储（只计 input+output，不含缓存读与 reasoning）。";

      const GAP_FIELDS = [
        { key: "minGapMs", label: "动作最小间隔（毫秒）", hint: "任意两次请求之间的硬间隔（平台安全带，不是额度）。" },
        { key: "writeGapSec", label: "两次写之间间隔（秒）", hint: "最低 30 秒：底层的速率闸对更小的值会静默抬到 30。" },
        { key: "dmGapSec", label: "两次私信之间间隔（秒）", hint: "允许填 0 = 私信不额外冷却。" },
      ];

      function useStyleOnce() {
        useEffect(() => {
          if (typeof document === "undefined") return;
          if (!document.getElementById(CSS_TAG)) {
            const el = document.createElement("style");
            el.id = CSS_TAG;
            el.textContent = CSS;
            document.head.appendChild(el);
          }
        }, []);
      }

      function Row(props) {
        return h("div", { className: "dbw-row" },
          h("div", null,
            h("div", { className: "dbw-label" }, props.label),
            props.hint ? h("div", { className: "dbw-hint" }, props.hint) : null),
          h("div", { className: "dbw-stack" }, props.children));
      }

      function asText(value) {
        return value === null || value === undefined ? "" : String(value);
      }

      /** 一句话描述登录态。**只看配置有没有**，这里不碰网络（设置页打开不该朝 B 站发包）。 */
      function loginLabel(cred) {
        if (cred === null || cred === undefined) return "未知";
        if (cred.hasSessdata !== true) return "未登录（没读到一个可用的 cookie）";
        const missing = Array.isArray(cred.missing) ? cred.missing : [];
        if (missing.length > 0) return "cookie 不完整，缺 " + missing.length + " 项";
        return "已配置 cookie（齐）";
      }

      function trafficLabel(traffic) {
        if (traffic === null || traffic === undefined) return "未知";
        if (traffic.banned === true) {
          return "熔断中，还剩 " + asText(traffic.banMinutesLeft) + " 分钟" + (traffic.banWhy ? "（" + traffic.banWhy + "）" : "");
        }
        return "正常" + (traffic.cacheEntries ? "（缓存 " + asText(traffic.cacheEntries) + " 条）" : "");
      }

      /** 千分位：1000000 → 1,000,000（界面上的 token 数动辄七位，不分组读不出来）。 */
      function fmtNum(value) {
        const n = Number(value);
        if (value === null || value === undefined || value === "" || !Number.isFinite(n)) return asText(value);
        return String(Math.floor(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
      }

      /** 去掉小数尾零：1.00 → "1"，1.50 → "1.5"。 */
      function trimZeros(value) {
        return String(Math.round(value * 100) / 100).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
      }

      /**
       * token 数 → 界面显示。**只在能精确表达时才换单位**：
       * 1000000 → "1M"、1500000 → "1.5M"、200000 → "200K"；
       * 而 1234000 用 M 只能写 1.23M（存回去就变成 1230000，等于偷偷改用户的预算），
       * 所以它退到 K："1234K"；连 K 都不精确就原样给数字。
       */
      function tokenFieldText(value) {
        const n = Number(value);
        if (value === null || value === undefined || String(value).trim() === "" || !Number.isFinite(n) || n <= 0) return asText(value);
        const exact = (unitValue, suffix) => {
          const scaled = n / unitValue;
          const rounded = Math.round(scaled * 100) / 100;
          return Math.abs(rounded * unitValue - n) < 1e-6 ? trimZeros(scaled) + suffix : null;
        };
        if (n >= 1e6) return exact(1e6, "M") ?? exact(1e3, "K") ?? String(n);
        if (n >= 1e3) return exact(1e3, "K") ?? String(n);
        return String(n);
      }

      /** 写通道冷却。写次数配额已经废弃（额度改成 token），这里只剩间隔还剩多少。
       *  core/quota.js 的 status 仍然带 writeGapLeftSec / dmGapLeftSec，拿它显示就够。 */
      function gapLabel(quota) {
        if (quota === null || quota === undefined) return "未知";
        const tail = [];
        const write = Number(quota.writeGapLeftSec);
        const dm = Number(quota.dmGapLeftSec);
        if (Number.isFinite(write) && write > 0) tail.push("写冷却剩 " + write + " 秒");
        if (Number.isFinite(dm) && dm > 0) tail.push("私信冷却剩 " + dm + " 秒");
        return tail.length ? tail.join(" · ") : "无冷却（可以立刻发）";
      }

      /** token 用量：本小时 / 今天 + 来源。source 不是 'ledger' 一律当"不可用"（fail-open，不拦也不吹）。 */
      function tokenLabel (tokens) {
        if (tokens === null || tokens === undefined) return "未知";
        const hour = tokens.hour ?? {};
        const day = tokens.day ?? {};
        const source = tokens.source === "ledger" ? "账本" : "不可用";
        if (tokens.source !== "ledger") return "（来源：" + source + "）";
        return "本小时 " + fmtNum(hour.used) + "/" + fmtNum(hour.limit) + " · 今天 " +
          fmtNum(day.used) + "/" + fmtNum(day.limit) + "（来源：" + source + "）";
      }

      function BiliSection() {
        useStyleOnce();
        const [status, setStatus] = useState(null);
        const [draft, setDraft] = useState({ mid: "", name: "", risk: {}, budget: {} });
        const [savedJson, setSavedJson] = useState("");
        const [cookie, setCookie] = useState("");
        const [busy, setBusy] = useState("");
        const [err, setErr] = useState("");
        const [out, setOut] = useState("");

        const adopt = useCallback((settings) => {
          const owner = settings?.owner ?? {};
          const risk = settings?.risk ?? {};
          const budget = settings?.budget ?? {};
          const nextRisk = {};
          for (const field of GAP_FIELDS) nextRisk[field.key] = asText(risk[field.key]);
          const nextBudget = {};
          for (const field of BUDGET_FIELDS) nextBudget[field.key] = tokenFieldText(budget[field.key]);
          const next = { mid: asText(owner.mid), name: asText(owner.name), risk: nextRisk, budget: nextBudget };
          setDraft(next);
          setSavedJson(JSON.stringify(next));
        }, []);

        const refreshStatus = useCallback(async () => {
          const r = await fetch(API + "/status", { headers: { accept: "application/json" } });
          if (!r.ok) throw new Error("HTTP " + r.status + (r.status === 403 ? "（被信任栅栏拒绝）" : ""));
          const j = await r.json();
          setStatus(j.data ?? null);
        }, []);

        const load = useCallback(async () => {
          setErr("");
          setOut("");
          try {
            const r = await fetch(API + "/settings", { headers: { accept: "application/json" } });
            if (!r.ok) throw new Error("HTTP " + r.status + (r.status === 403 ? "（被信任栅栏拒绝）" : ""));
            const j = await r.json();
            adopt(j.data ?? {});
            await refreshStatus();
          } catch (e) {
            setErr("读取设置失败：" + e.message);
          }
        }, [adopt, refreshStatus]);

        useEffect(() => { load(); }, [load]);

        const dirty = savedJson !== "" && JSON.stringify(draft) !== savedJson;

        const setOwner = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
        const setRisk = (key, value) =>
          setDraft((d) => ({ ...d, risk: { ...d.risk, [key]: value } }));
        const setBudget = (key, value) =>
          setDraft((d) => ({ ...d, budget: { ...d.budget, [key]: value } }));

        const saveSettings = async () => {
          setBusy("settings");
          setErr("");
          setOut("");
          try {
            const r = await fetch(API + "/settings", {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json" },
              body: JSON.stringify({ owner: { mid: draft.mid, name: draft.name }, risk: draft.risk, budget: draft.budget }),
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
            adopt(j.data ?? {});
            await refreshStatus();
            setOut("✓ 已保存，下一次工具调用立即生效（不用重启）" + String.fromCharCode(10) + "文件：" + asText(j.configPath));
          } catch (e) {
            setErr("保存失败：" + e.message);
          } finally { setBusy(""); }
        };

        const saveCookie = async () => {
          if (cookie.trim() === "") { setErr("先粘贴 cookie 再保存"); return; }
          setBusy("cookie");
          setErr("");
          setOut("");
          try {
            const r = await fetch(API + "/credential", {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json" },
              body: JSON.stringify({ cookie }),
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
            setCookie("");                     // 保存成功立刻清空：值不该留在页面上
            await refreshStatus();
            setOut("✓ 凭据已保存（不回显、不进日志）。当前：登录态 " + loginLabel(j.data));
          } catch (e) {
            setErr("保存凭据失败：" + e.message);
          } finally { setBusy(""); }
        };

        if (status === null) {
          return h("div", { className: "dbw" },
            h("h3", { className: "dbw-title" }, "B站账号"),
            err ? h("div", { className: "dbw-err" }, err) : h("div", { className: "dbw-hint" }, "读取中…"));
        }

        const cred = status.credentials ?? null;
        const quota = status.quota ?? null;

        return h("div", { className: "dbw" },
          h("h3", { className: "dbw-title" }, "B站账号"),
          h("p", { className: "dbw-intro" },
            "只读状态 + 主人身份 + token 预算 + cookie。额度按花费的 token 算（不分读写次数）。改完点保存就生效，不用重启。凭据只显示齐不齐，永远不回显内容。"),

          h("div", { className: "dbw-group" }, "当前状态"),
          h("div", { className: "dbw-rows" },
            h("div", { className: "dbw-row" },
              h("div", null,
                h("div", { className: "dbw-hint" }, "登录态"),
                h("div", { className: "dbw-mono" }, loginLabel(cred))),
              h("div", null,
                h("div", { className: "dbw-hint" }, "限速 / 熔断"),
                h("div", { className: "dbw-mono" }, trafficLabel(status.traffic)))),
            h("div", { className: "dbw-row" },
              h("div", null,
                h("div", { className: "dbw-hint" }, "token 用量（额度的唯一口径）"),
                h("div", { className: "dbw-mono" }, tokenLabel(status.tokens))),
              h("div", null,
                h("div", { className: "dbw-hint" }, "凭据缺口"),
                h("div", { className: "dbw-mono" },
                  Array.isArray(cred?.missing) && cred.missing.length ? cred.missing.join("、") : "（无缺口）"))),
            h("div", { className: "dbw-row" },
              h("div", null,
                h("div", { className: "dbw-hint" }, "写通道冷却"),
                h("div", { className: "dbw-mono" }, gapLabel(quota))),
              h("div", null,
                h("div", { className: "dbw-hint" }, "版本 · 工具 · 能力"),
                h("div", { className: "dbw-mono" },
                  asText(status.version) + " · " + asText(status.tools) + " 个工具 · " +
                  asText((status.capabilities ?? []).length) + " 项能力")))),

          h("div", { className: "dbw-group" }, "主人身份"),
          h("div", { className: "dbw-rows" },
            h(Row, { label: "mid", hint: "纯数字串。私信只发给这个 mid；留空 = 不改（当前 " + asText(draft.mid) + "）。" },
              h("input", {
                className: "dbw-input", inputMode: "numeric", placeholder: "例如 389989266",
                value: draft.mid, onChange: (e) => setOwner("mid", e.target.value),
              })),
            h(Row, { label: "昵称", hint: "只用于提示文案，留空 = 不改。" },
              h("input", {
                className: "dbw-input dbw-wide", placeholder: "主人昵称",
                value: draft.name, onChange: (e) => setOwner("name", e.target.value),
              }))),

          h("div", { className: "dbw-group" }, "token 预算（额度）"),
          h("div", { className: "dbw-rows" },
            BUDGET_FIELDS.map((field) =>
              h(Row, { key: field.key, label: field.label, hint: BUDGET_HINT },
                h("input", {
                  className: "dbw-input", type: "text", inputMode: "numeric", spellCheck: false,
                  placeholder: "200K / 1.5M / 8000000",
                  value: draft.budget[field.key] ?? "",
                  onChange: (e) => setBudget(field.key, e.target.value),
                })))),

          h("div", { className: "dbw-group" }, "间隔（平台安全带，不是额度）"),
          h("div", { className: "dbw-rows" },
            GAP_FIELDS.map((field) =>
              h(Row, { key: field.key, label: field.label, hint: field.hint },
                h("input", {
                  className: "dbw-input", type: "number", min: 0,
                  value: draft.risk[field.key] ?? "",
                  onChange: (e) => setRisk(field.key, e.target.value),
                })))),

          h("div", { className: "dbw-group" }, "cookie"),
          h("div", { className: "dbw-rows" },
            h(Row, {
              label: "粘贴 cookie",
              hint: "整段复制 cookie 头（SESSDATA=…; bili_jct=…; buvid3=…）或一段 JSON。只进不出：保存成功后输入框立刻清空，任何时候都不回显。",
            },
              h("input", {
                className: "dbw-input dbw-wide", type: "password", autoComplete: "off", spellCheck: false,
                placeholder: "SESSDATA=…; bili_jct=…; buvid3=…",
                value: cookie, onChange: (e) => setCookie(e.target.value),
              }))),

          h("div", { className: "dbw-actions" },
            h("button", { className: "dbw-btn", onClick: saveSettings, disabled: !!busy }, busy === "settings" ? "保存中…" : "保存设置"),
            h("button", { className: "dbw-btn", onClick: saveCookie, disabled: !!busy || cookie.trim() === "" }, busy === "cookie" ? "保存中…" : "保存 cookie"),
            h("button", { className: "dbw-btn dbw-btn2", onClick: load, disabled: !!busy }, "重新读取"),
            dirty ? h("span", { className: "dbw-dirty" }, "● 有改动还没保存") : null),

          err ? h("div", { className: "dbw-err" }, err) : null,
          out ? h("div", { className: "dbw-out" }, out) : null,
          h("div", { className: "dbw-hint" },
            "保存走同源 POST /dsh-bili/api/kernel/settings（整份校验后原子写），凭据单独走 /dsh-bili/api/kernel/credential。"));
      }

      // ──「她」：自主运营层的设置页 ─────────────────────────────────────────────
      // core 侧模块还没落盘时后端回 { available:false }：这页显示「自主层未就绪」并禁用按钮，
      // 不做假开关 —— 点了没反应的开关比没有开关更糟。
      const SELF_CHANNELS = [
        { key: "read", label: "读（刷热门 / 读评论 / 读收件箱）" },
        { key: "dm", label: "私信主人" },
        { key: "comment", label: "发评论" },
        { key: "reply", label: "回复评论" },
        { key: "dynamic", label: "发动态" },
        { key: "like", label: "点赞" },
        { key: "follow", label: "关注" },
      ];
      const SELF_CAP_KEYS = ["dm", "comment", "reply", "dynamic", "like", "follow"];

      // 人设的结构化字段（§15）：界面上**不出现任何 markdown 原文**，只有这些字段。
      const PERSONA_LIST_KEYS = ["personality", "interests", "dislikes", "phrases", "boundaries"];
      const PERSONA_LABELS = {
        tagline: "一句话", personality: "性格", interests: "兴趣",
        dislikes: "雷点", phrases: "语料", boundaries: "边界",
      };
      const PERSONA_FIELDS = [
        { key: "tagline", label: "一句话", hint: "她是怎样一个人，一句话说完（≤200 字）。", multiline: false },
        { key: "personality", label: "性格", hint: "三行：外层 / 中层 / 里层。一行一项，保存时按行拆分。", multiline: true },
        { key: "interests", label: "兴趣", hint: "她喜欢什么。一行一项，保存时按行拆分。", multiline: true },
        { key: "dislikes", label: "雷点", hint: "她讨厌什么。一行一项，保存时按行拆分。", multiline: true },
        { key: "phrases", label: "语料", hint: "她的口头样本，一行一句。一行一项，保存时按行拆分。", multiline: true },
        { key: "boundaries", label: "边界", hint: "绝不越过的线。一行一项，保存时按行拆分。", multiline: true },
      ];

      // 六项状态指标：**只读**。它们由经历（事件表）自动变化，界面不给任何编辑入口 ——
      // 想改变她的状态只有两条路：改人设，或者让她去经历事情。
      const METRIC_FIELDS = [
        { key: "energy", label: "精力" },
        { key: "mood", label: "心情" },
        { key: "curiosity", label: "好奇" },
        { key: "affinity", label: "亲近" },
        { key: "boredom", label: "倦怠" },
        { key: "confidence", label: "自信" },
      ];
      const METRIC_LABELS = { energy: "精力", mood: "心情", curiosity: "好奇", affinity: "亲近", boredom: "倦怠", confidence: "自信" };
      // 热梗库来源 / 状态的中文（§14.3 的三个 source、两个 stage）
      const MEME_SOURCE_LABELS = { web_search: "联网", llm: "模型", unavailable: "不可用" };
      const MEME_STAGE_LABELS = { fresh: "新鲜", stale: "过期" };
      // 作息预设（§14.2）：点了只填表单，不自动保存
      // §16：预设写的是**时段列表**（不再是一个 window）。点了只填表单，不保存。
      const SCHEDULE_PRESETS = [
        { key: "night", label: "夜行", windows: [{ start: "20:00", end: "24:00" }], intervalMin: 45 },
        { key: "day", label: "白天", windows: [{ start: "09:00", end: "12:00" }, { start: "14:00", end: "18:00" }], intervalMin: 60 },
        { key: "always", label: "全天", windows: [{ start: "00:00", end: "24:00" }], intervalMin: 90 },
      ];
      const WINDOWS_MAX = 6;

      const EVENT_LABELS = {
        "wake": "醒来", "read-action": "读了一次", "write-action": "写了一次",
        "action-ok": "行动成功", "action-fail": "行动失败", "risk": "撞到风控",
        "interest-hit": "遇到有趣的", "repeat": "重复了", "dm-sent": "发了私信",
        "owner-reply": "主人回复", "day-pass": "跨天恢复",
      };

      /** ISO 时间 → HH:MM（本地时区，读不出来就原样返回）。 */
      /**
       * 时间 → 人话：「今天 14:29」/「昨天 14:29」/「明天 18:30」/「11月1日 14:29」/「2025年12月31日 23:10」。
       * 两种输入都吃：ISO 字符串（lastWakeAt）与毫秒时间戳（nextWakeAt），也吃 Date 与数字串。
       * 空值 / 非法值一律给「—」—— 界面上绝不出现 Invalid Date 或 NaN。
       */
      function fmtWhen (value) {
        let ms = NaN;
        if (typeof value === "number") ms = value;
        else if (value instanceof Date) ms = value.getTime();
        else if (typeof value === "string") {
          const text = value.trim();
          if (text === "") return "—";
          ms = /^\d+$/.test(text) ? Number(text) : Date.parse(text);
        }
        if (!Number.isFinite(ms)) return "—";
        const date = new Date(ms);
        const at = date.getTime();
        if (!Number.isFinite(at)) return "—";

        const pad = (n) => (n < 10 ? "0" + n : String(n));
        const clock = pad(date.getHours()) + ":" + pad(date.getMinutes());
        const now = new Date();
        const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const dayDiff = Math.round((dayStart(date) - dayStart(now)) / 86400000);
        if (dayDiff === 0) return "今天 " + clock;
        if (dayDiff === -1) return "昨天 " + clock;
        if (dayDiff === 1) return "明天 " + clock;
        const monthDay = (date.getMonth() + 1) + "月" + date.getDate() + "日";
        const sameYear = date.getFullYear() === now.getFullYear();
        return (sameYear ? monthDay : date.getFullYear() + "年" + monthDay) + " " + clock;
      }

      function clockOf (value) {
        if (typeof value !== "string" || value === "") return "";
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return value;
        const pad = (n) => (n < 10 ? "0" + n : String(n));
        return pad(date.getHours()) + ":" + pad(date.getMinutes());
      }

      /** 一条变化 → 「自信 +1」；没有变化就说「无变化」。 */
      function changeText (changes) {
        const list = Array.isArray(changes) ? changes : [];
        if (list.length === 0) return "无变化";
        return list.map((change) => {
          const label = METRIC_LABELS[change.key] || change.key;
          const delta = Number(change.delta);
          return label + " " + (delta > 0 ? "+" : "") + (Number.isFinite(delta) ? delta : 0);
        }).join(" · ");
      }

      function SelfSection() {
        useStyleOnce();
        const [state, setState] = useState(null);
        const [draft, setDraft] = useState(null);
        const [personaDraft, setPersonaDraft] = useState(null);
        const [personaSaved, setPersonaSaved] = useState("");
        const [personaNotes, setPersonaNotes] = useState("");
        const [personaAvailable, setPersonaAvailable] = useState(false);
        const [profile, setProfile] = useState({ name: "", ownerTitle: "", available: false });
        const [memes, setMemes] = useState(null);
        const [busy, setBusy] = useState("");
        const [err, setErr] = useState("");
        const [out, setOut] = useState("");

        const adopt = useCallback((data) => {
          const allowsSrc = data.allows ?? {};
          const capsSrc = data.caps ?? {};
          const windowSrc = data.window ?? {};
          const allows = {};
          for (const channel of SELF_CHANNELS) allows[channel.key] = allowsSrc[channel.key] === true;
          const caps = {};
          // null = 不限 → 输入框留空；数字照常回显。
          // 界面上只剩「动态」一项：缺省（undefined）按 2 显示，null（不限）显示为空串。
          // 其余五项仍然读进 draft（不显示），这样后端回什么都不会因为界面简化而丢字段。
          for (const key of SELF_CAP_KEYS) {
            if (key === "dynamic") {
              caps[key] = capsSrc.dynamic === null ? "" : (capsSrc.dynamic === undefined ? "2" : asText(capsSrc.dynamic));
              continue;
            }
            caps[key] = capsSrc[key] === null || capsSrc[key] === undefined ? "" : asText(capsSrc[key]);
          }
          setState(data);
          setDraft({
            enabled: data.enabled !== false,
            allows,
            caps,
            windows: (Array.isArray(data.windows) && data.windows.length > 0 ? data.windows : [windowSrc]).map((item) => ({
              start: asText(item && item.start),
              end: asText(item && item.end),
            })),
            weekendAllDay: data.weekendAllDay === true,
            weekendIntervalMin: asText(data.weekendIntervalMin === undefined ? 90 : data.weekendIntervalMin),
            // 缺字段（老 core）按 true 显示
            minWatchPerWake: data.minWatchPerWake !== false,
            atOwnerOnComment: data.atOwnerOnComment !== false,
            bedtimeReport: data.bedtimeReport !== false,
            commentAfterWatch: data.commentAfterWatch !== false,
            replyToDm: data.replyToDm !== false,
            replyToComments: data.replyToComments !== false,
            replyToMentions: data.replyToMentions !== false,
            // 这个默认关：缺字段 → false（与上面三个相反，别抄错）
            dmEveryWake: data.dmEveryWake === true,
            intervalMin: asText(data.intervalMin),
            jitter: asText(data.jitter),
            llmProvider: asText(data.llmProvider),
            llmModel: asText(data.llmModel),
          });
        }, []);


        /** 把后端返回的结构化人设抹成界面草稿（列表在界面上是"一行一项"的文本）。 */
        const adoptPersona = useCallback((data) => {
          const sections = data === null || data === undefined ? null : data.sections;
          const live = sections !== null && sections !== undefined;
          const next = { tagline: asText(live ? sections.tagline : "") };
          for (const key of PERSONA_LIST_KEYS) {
            const list = live && Array.isArray(sections[key]) ? sections[key] : [];
            next[key] = list.join("\n");
          }
          setPersonaDraft(next);
          setPersonaSaved(JSON.stringify(next));
          setPersonaNotes(asText(data === null || data === undefined ? "" : data.notes));
          setPersonaAvailable(live);
        }, []);

        const loadPersona = useCallback(async () => {
          try {
            const r = await fetch(SELF_API + "/persona", { headers: { accept: "application/json" } });
            if (!r.ok) return;
            const j = await r.json();
            adoptPersona(j.data ?? {});
          } catch { /* 人设读不到不影响整页 */ }
        }, [adoptPersona]);

        const loadProfile = useCallback(async () => {
          try {
            const r = await fetch(SELF_API + "/profile", { headers: { accept: "application/json" } });
            if (!r.ok) return;
            const j = await r.json();
            const d = j.data ?? {};
            setProfile({ name: asText(d.name), ownerTitle: asText(d.ownerTitle), available: d.available !== false });
          } catch { /* 身份字段读不到不影响整页 */ }
        }, []);

        const loadMemes = useCallback(async () => {
          try {
            const r = await fetch(SELF_API + "/memes", { headers: { accept: "application/json" } });
            if (!r.ok) return;
            const j = await r.json();
            setMemes(j.data ?? { available: false });
          } catch { /* 热梗库坏了也不带走整页 */ }
        }, []);

        const load = useCallback(async () => {
          setErr("");
          setOut("");
          try {
            const r = await fetch(SELF_API + "/state", { headers: { accept: "application/json" } });
            if (!r.ok) throw new Error("HTTP " + r.status + (r.status === 403 ? "（被信任栅栏拒绝）" : ""));
            const j = await r.json();
            const data = j.data ?? {};
            adopt(data);
            await loadPersona();
            await loadProfile();
            await loadMemes();
          } catch (e) {
            setErr("读取「她」失败：" + e.message);
          }
        }, [adopt, loadPersona, loadProfile, loadMemes]);

        useEffect(() => { load(); }, [load]);

        const setField = (key, value) => setDraft((d) => ({ ...d, [key]: value }));
        const setAllow = (key, value) => setDraft((d) => ({ ...d, allows: { ...d.allows, [key]: value } }));
        const setCap = (key, value) => setDraft((d) => ({ ...d, caps: { ...d.caps, [key]: value } }));


        /** 作息预设：**只填表单**，不自动保存 —— 误触一次不该改掉她的作息。 */
        const applyPreset = (preset) => {
          setDraft((d) => ({
            ...d,
            windows: preset.windows.map((item) => ({ start: item.start, end: item.end })),
            weekendAllDay: false,
            intervalMin: String(preset.intervalMin),
          }));
          setErr("");
          setOut("已填入「" + preset.label + "」预设（" + preset.windows.map((item) => item.start + "–" + item.end).join("、") +
            "，每 " + preset.intervalMin + " 分钟）；还要点「保存设置」才生效");
        };

        const setWindowPart = (index, key, value) =>
          setDraft((d) => ({ ...d, windows: d.windows.map((item, i) => (i === index ? { ...item, [key]: value } : item)) }));
        const addWindow = () =>
          setDraft((d) => (d.windows.length >= WINDOWS_MAX ? d : { ...d, windows: d.windows.concat([{ start: "20:00", end: "24:00" }]) }));
        const removeWindow = (index) =>
          setDraft((d) => (d.windows.length <= 1 ? d : { ...d, windows: d.windows.filter((_, i) => i !== index) }));

        const saveProfile = async () => {
          setBusy("profile");
          setErr("");
          setOut("");
          try {
            const r = await fetch(SELF_API + "/profile", {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json" },
              body: JSON.stringify({ name: profile.name, ownerTitle: profile.ownerTitle }),
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
            await loadProfile();
            setOut("✓ 名字 / 称呼已写入 persona.md 的头部（正文没动）");
          } catch (e) {
            setErr("保存身份失败：" + e.message);
          } finally { setBusy(""); }
        };

        const refreshMemes = async () => {
          setBusy("meme");
          setErr("");
          setOut("");
          try {
            const r = await fetch(SELF_API + "/meme-refresh", { method: "POST", headers: { accept: "application/json" } });
            const j = await r.json().catch(() => ({}));
            if (r.status === 409) throw new Error("正在刷新（上一次还没结束），等一会儿再点");
            if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
            const d = j.data ?? {};
            await loadMemes();
            if (d.ok === true) setOut("✓ 热梗库已更新：" + asText(d.count) + " 条，来源 " + (MEME_SOURCE_LABELS[d.source] || asText(d.source)));
            else setErr("刷新失败：" + asText(d.error) + "（旧列表保留，状态会标成过期）");
          } catch (e) {
            setErr("刷新热梗库失败：" + e.message);
          } finally { setBusy(""); }
        };

        const save = async () => {
          setBusy("save");
          setErr("");
          setOut("");
          try {
            const r = await fetch(SELF_API + "/settings", {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json" },
              body: JSON.stringify({
                enabled: draft.enabled,
                allows: draft.allows,
                // 只提交 dynamic：后端是部分更新，没提交的键（评论/回复/点赞/关注/私信）
                // 保持原值（现在是 null = 不限）。界面简化不该把已有配置写坏。
                caps: (() => {
                  const raw = String(draft.caps.dynamic ?? "").trim();
                  return { dynamic: raw === "" ? null : raw };
                })(),
                windows: draft.windows,
                weekendAllDay: draft.weekendAllDay,
                weekendIntervalMin: draft.weekendIntervalMin,
                minWatchPerWake: draft.minWatchPerWake,
                atOwnerOnComment: draft.atOwnerOnComment,
                bedtimeReport: draft.bedtimeReport,
                dmEveryWake: draft.dmEveryWake,
                commentAfterWatch: draft.commentAfterWatch,
                replyToDm: draft.replyToDm,
                replyToComments: draft.replyToComments,
                replyToMentions: draft.replyToMentions,
                intervalMin: draft.intervalMin,
                jitter: draft.jitter,
                llmProvider: draft.llmProvider,
                llmModel: draft.llmModel,
              }),
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
            await load();
            setOut("✓ 已保存，下一次 tick 就用新设置（不用重启）" +
              (draft.dmEveryWake ? String.fromCharCode(10) + "会比较吵，可以随时关掉" : ""));
          } catch (e) {
            setErr("保存失败：" + e.message);
          } finally { setBusy(""); }
        };

        /** 只提交**改动过的节**（前端 diff）：没动的节一个字节都不会被重写。 */
        const savePersona = async () => {
          if (personaDraft === null) return;
          let saved = {};
          try { saved = JSON.parse(personaSaved || "{}"); } catch { saved = {}; }
          const patch = {};
          const changed = [];
          if (personaDraft.tagline !== saved.tagline) {
            patch.tagline = personaDraft.tagline;
            changed.push("tagline");
          }
          for (const key of PERSONA_LIST_KEYS) {
            if (personaDraft[key] === saved[key]) continue;
            patch[key] = String(personaDraft[key] || "").split("\n").map((line) => line.trim()).filter((line) => line !== "");
            changed.push(key);
          }
          if (changed.length === 0) {
            setErr("");
            setOut("没有改动，不用保存");
            return;
          }
          setBusy("persona");
          setErr("");
          setOut("");
          try {
            const r = await fetch(SELF_API + "/persona", {
              method: "POST",
              headers: { "content-type": "application/json", accept: "application/json" },
              body: JSON.stringify({ sections: patch }),
            });
            const j = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
            adoptPersona(j.data ?? {});
            setOut("✓ 已保存（只改了：" + changed.map((key) => PERSONA_LABELS[key] || key).join("、") + "），下一次醒就生效");
          } catch (e) {
            setErr("保存人设失败：" + e.message);
          } finally { setBusy(""); }
        };

        const wake = async () => {
          setBusy("wake");
          setErr("");
          setOut("");
          try {
            const r = await fetch(SELF_API + "/run-once", { method: "POST", headers: { accept: "application/json" } });
            const j = await r.json().catch(() => ({}));
            if (r.status === 409) throw new Error("已经醒着（上一次还没跑完），等一会儿再点");
            if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
            setOut("✓ 已叫醒她。结果写进审计，几十秒后点「重新读取」就能看到");
          } catch (e) {
            setErr("唤醒失败：" + e.message);
          } finally { setBusy(""); }
        };
        if (state === null || draft === null) {
          return h("div", { className: "dbw" },
            h("h3", { className: "dbw-title" }, "她"),
            err ? h("div", { className: "dbw-err" }, err) : h("div", { className: "dbw-hint" }, "读取中…"));
        }

        const notReady = state.available === false;
        const disabled = notReady || !!busy;
        const counts = state.todayCounts ?? {};
        const audit = Array.isArray(state.auditTail) ? state.auditTail : [];
        const countsText = SELF_CAP_KEYS.map((key) => key + " " + asText(counts[key] ?? 0)).join(" · ");
        // 下次醒可能是毫秒数或 null：统一交给 fmtWhen，认不出来就是「—」。
        const nextWakeText = fmtWhen(state.nextWakeAt);
        const memeReady = memes !== null && memes !== undefined && memes.available !== false;
        const memeItems = memeReady && Array.isArray(memes.items) ? memes.items : [];
        const memeStatus = memeReady
          ? "更新于 " + (memes.staleDays === null || memes.staleDays === undefined ? "未知" : memes.staleDays + " 天前") +
            " · " + asText(memes.count) + " 条" +
            " · 来源（" + (MEME_SOURCE_LABELS[memes.source] || "不可用") + "）" +
            " · 状态（" + (MEME_STAGE_LABELS[memes.stage] || "新鲜") + "）"
          : "";

        return h("div", { className: "dbw" },
          h("h3", { className: "dbw-title" }, "她"),
          h("p", { className: "dbw-intro" },
            "自主运营层：她自己决定说不说话、说什么。默认只读 + 私信主人，公开表态一律默认关。改完点保存就生效。"),
          notReady ? h("div", { className: "dbw-err" }, "自主层未就绪：" + asText(state.reason) + "（内核模块落盘后点「重新读取」即可）") : null,

          h("div", { className: "dbw-group" }, "身份"),
          h("div", { className: "dbw-rows" },
            h(Row, { label: "名字", hint: "她叫什么（≤20 字）。改名后下一次醒来生效。" },
              h("input", {
                className: "dbw-input", type: "text", maxLength: 20, placeholder: "赛博友人",
                value: profile.name, disabled: disabled || profile.available === false,
                onChange: (e) => setProfile((p) => ({ ...p, name: e.target.value })),
              })),
            h(Row, { label: "称呼主人", hint: "她怎么称呼你（≤20 字）。改名后下一次醒来生效。" },
              h("input", {
                className: "dbw-input", type: "text", maxLength: 20, placeholder: "主人",
                value: profile.ownerTitle, disabled: disabled || profile.available === false,
                onChange: (e) => setProfile((p) => ({ ...p, ownerTitle: e.target.value })),
              })),
            profile.available === false
              ? h("div", { className: "dbw-hint" }, "身份字段未就绪（core/persona.js 的 readProfile / writeProfile 还没落盘），先显示默认值")
              : null),

          h("div", { className: "dbw-group" }, "状态"),
          h("div", { className: "dbw-rows" },
            h("div", { className: "dbw-row" },
              h("div", null,
                h("div", { className: "dbw-hint" }, "心情"),
                h("div", { className: "dbw-mono" }, asText(state.mood) || "—")),
              h("div", null,
                h("div", { className: "dbw-hint" }, "上一句"),
                h("div", { className: "dbw-mono" }, asText(state.lastLine) || "—"))),
            h("div", { className: "dbw-row" },
              h("div", null,
                h("div", { className: "dbw-hint" }, "上次醒"),
                h("div", { className: "dbw-mono" }, fmtWhen(state.lastWakeAt))),
              h("div", null,
                h("div", { className: "dbw-hint" }, "下次醒" + (nextWakeText === "—" ? "" : "（不在清醒时段时指向下一个时段开始）")),
                h("div", { className: "dbw-mono" }, nextWakeText))),
            h("div", { className: "dbw-row" },
              h("div", null,
                h("div", { className: "dbw-hint" }, "今日动作数"),
                h("div", { className: "dbw-mono" }, countsText)))),

          h("div", { className: "dbw-group" }, "状态指标"),
          h("div", { className: "dbw-rows" },
            h("div", { className: "dbw-hint" }, "由经历自动变化，不可手工编辑"),
            state.metrics === null || state.metrics === undefined
              ? h("div", { className: "dbw-hint" }, "指标未就绪")
              : h("div", null,
                METRIC_FIELDS.map((field) => {
                  const value = Number(state.metrics[field.key]);
                  const shown = Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : null;
                  return h("div", { className: "dbw-row", key: "metric-" + field.key },
                    h("div", null,
                      h("div", { className: "dbw-label" }, field.label),
                      h("div", { className: "dbw-hint" }, shown === null ? "—" : String(shown))),
                    h("div", { className: "dbw-stack", style: { flex: 1 } },
                      h("div", {
                        style: {
                          width: "160px", height: "4px", borderRadius: "2px",
                          background: "var(--dsw-alias-border-l2)", overflow: "hidden",
                        },
                      },
                        h("div", {
                          style: {
                            width: (shown === null ? 0 : shown) + "%", height: "100%",
                            background: "var(--dsw-alias-brand-primary)",
                          },
                        }))));
                }),
                h("div", { className: "dbw-hint" },
                  METRIC_FIELDS.map((field) => {
                    const value = Number(state.metrics[field.key]);
                    return field.label + " " + (Number.isFinite(value) ? Math.round(value) : "—");
                  }).join(" · "))),
            h("div", { className: "dbw-hint" }, "最近变化"),
            !Array.isArray(state.metricsRecent) || state.metricsRecent.length === 0
              ? h("div", { className: "dbw-hint" }, "（还没有变化记录）")
              : h("div", null,
                state.metricsRecent.slice(0, 5).map((entry, index) =>
                  h("div", { className: "dbw-mono", key: "change-" + index },
                    clockOf(entry && entry.at) + " " +
                    (EVENT_LABELS[entry && entry.event] || asText(entry && entry.event) || "事件") + " → " +
                    changeText(entry && entry.changes))))),
          h("div", { className: "dbw-group" }, "开关"),
          h("div", { className: "dbw-rows" },
            h(Row, { label: "总开关", hint: "关掉 = 连只读与私信也不做，只是活着。" },
              h("label", { className: "dbw-mono" },
                h("input", {
                  type: "checkbox", checked: draft.enabled, disabled: notReady,
                  onChange: (e) => setDraft((d) => ({ ...d, enabled: e.target.checked })),
                }),
                draft.enabled ? " 已启用" : " 已停用")),
            SELF_CHANNELS.map((channel) =>
              h(Row, { key: channel.key, label: channel.label, hint: channel.key === "read" || channel.key === "dm" ? "默认开" : "默认关：公开表态" },
                h("label", { className: "dbw-mono" },
                  h("input", {
                    type: "checkbox", checked: draft.allows[channel.key] === true, disabled: notReady,
                    onChange: (e) => setAllow(channel.key, e.target.checked),
                  }),
                  draft.allows[channel.key] === true ? " 允许" : " 禁止"))),
            h(Row, { label: "每次醒来至少看一个视频", hint: "关掉后她可能一整轮什么都不做。" },
              h("label", { className: "dbw-mono" },
                h("input", {
                  type: "checkbox", checked: draft.minWatchPerWake, disabled: notReady,
                  onChange: (e) => setDraft((d) => ({ ...d, minWatchPerWake: e.target.checked })),
                }),
                draft.minWatchPerWake ? " 已开启" : " 已关闭")),
            h(Row, { label: "发评论时 @主人", hint: "她会 @ 你，你能收到提醒" },
              h("label", { className: "dbw-mono" },
                h("input", {
                  type: "checkbox", checked: draft.atOwnerOnComment, disabled: notReady,
                  onChange: (e) => setDraft((d) => ({ ...d, atOwnerOnComment: e.target.checked })),
                }),
                draft.atOwnerOnComment ? " 已开启" : " 已关闭")),
            h(Row, { label: "睡前私信汇报", hint: "每次进入睡眠前，用私信告诉你今天做了什么" },
              h("label", { className: "dbw-mono" },
                h("input", {
                  type: "checkbox", checked: draft.bedtimeReport, disabled: notReady,
                  onChange: (e) => setDraft((d) => ({ ...d, bedtimeReport: e.target.checked })),
                }),
                draft.bedtimeReport ? " 已开启" : " 已关闭")),
            h(Row, { label: "每次醒来发私信", hint: "她会每醒一次就告诉你做了什么（可能一晚十几条）" },
              h("label", { className: "dbw-mono" },
                h("input", {
                  type: "checkbox", checked: draft.dmEveryWake, disabled: notReady,
                  onChange: (e) => setDraft((d) => ({ ...d, dmEveryWake: e.target.checked })),
                }),
                draft.dmEveryWake ? " 已开启" : " 已关闭")),
            h(Row, { label: "看完视频就评论并 @ 你", hint: "每轮醒来最多一条；频率偏高，觉得吵可以关掉" },
              h("label", { className: "dbw-mono" },
                h("input", {
                  type: "checkbox", checked: draft.commentAfterWatch, disabled: notReady,
                  onChange: (e) => setDraft((d) => ({ ...d, commentAfterWatch: e.target.checked })),
                }),
                draft.commentAfterWatch ? " 已开启" : " 已关闭")),
            h(Row, { label: "你私信她时她会回", hint: "回的是她那一轮想说的话" },
              h("label", { className: "dbw-mono" },
                h("input", {
                  type: "checkbox", checked: draft.replyToDm, disabled: notReady,
                  onChange: (e) => setDraft((d) => ({ ...d, replyToDm: e.target.checked })),
                }),
                draft.replyToDm ? " 已开启" : " 已关闭")),
            h(Row, { label: "别人回复她的评论时她会回", hint: "每轮最多回一条，最多查 3 条最新评论" },
              h("label", { className: "dbw-mono" },
                h("input", {
                  type: "checkbox", checked: draft.replyToComments, disabled: notReady,
                  onChange: (e) => setDraft((d) => ({ ...d, replyToComments: e.target.checked })),
                }),
                draft.replyToComments ? " 已开启" : " 已关闭")),
            h(Row, { label: "有人 @ 她时她会回", hint: "只能回评论区里的 @；动态/视频里的 @ 暂时回不了" },
              h("label", { className: "dbw-mono" },
                h("input", {
                  type: "checkbox", checked: draft.replyToMentions, disabled: notReady,
                  onChange: (e) => setDraft((d) => ({ ...d, replyToMentions: e.target.checked })),
                }),
                draft.replyToMentions ? " 已开启" : " 已关闭"))),

          h("div", { className: "dbw-group" }, "日程"),
          h("div", { className: "dbw-rows" },
            h(Row, { label: "清醒时段（最多 " + WINDOWS_MAX + " 个）", hint: "HH:MM，24 小时制；结束允许 24:00；起 > 止 = 跨到次日。" },
              h("div", { className: "dbw-stack" },
                draft.windows.map((item, index) =>
                  h("div", { key: "window-" + index, style: { display: "flex", gap: "6px", alignItems: "center" } },
                    h("input", {
                      className: "dbw-input", type: "text", placeholder: "20:00",
                      value: item.start, disabled: notReady,
                      onChange: (e) => setWindowPart(index, "start", e.target.value),
                    }),
                    h("span", { className: "dbw-hint" }, "–"),
                    h("input", {
                      className: "dbw-input", type: "text", placeholder: "24:00",
                      value: item.end, disabled: notReady,
                      onChange: (e) => setWindowPart(index, "end", e.target.value),
                    }),
                    h("button", {
                      className: "dbw-btn dbw-btn2", type: "button",
                      disabled: notReady || draft.windows.length <= 1,
                      onClick: () => removeWindow(index),
                    }, "删除"))),
                h("button", {
                  className: "dbw-btn dbw-btn2", type: "button",
                  disabled: notReady || draft.windows.length >= WINDOWS_MAX,
                  onClick: addWindow,
                }, "+ 添加时段"),
                draft.windows.length >= WINDOWS_MAX
                  ? h("div", { className: "dbw-hint" }, "最多 " + WINDOWS_MAX + " 个时段")
                  : null)),
            h(Row, { label: "周六周日全天在线", hint: "勾上 = 周末 00:00–24:00 一直在线，间隔用周末间隔（缺省回落 intervalMin）。" },
              h("div", { className: "dbw-stack" },
                h("label", { className: "dbw-mono" },
                  h("input", {
                    type: "checkbox", checked: draft.weekendAllDay, disabled: notReady,
                    onChange: (e) => setDraft((d) => ({ ...d, weekendAllDay: e.target.checked })),
                  }),
                  draft.weekendAllDay ? " 已开启" : " 未开启"),
                draft.weekendAllDay
                  ? h("input", {
                    className: "dbw-input", type: "number", min: 5, max: 720,
                    placeholder: "周末间隔（分钟）", title: "周末间隔（分钟，5–720）",
                    value: draft.weekendIntervalMin, disabled: notReady,
                    onChange: (e) => setField("weekendIntervalMin", e.target.value),
                  })
                  : null)),
            h(Row, { label: "间隔（分钟）", hint: "两次醒之间的基准间隔，1–1440。" },
              h("input", { className: "dbw-input", type: "number", min: 1, max: 1440, value: draft.intervalMin, onChange: (e) => setField("intervalMin", e.target.value) })),
            h(Row, { label: "抖动（0–1）", hint: "0.2 = 间隔在上下 20% 之间随机；太规律容易被看出是脚本。" },
              h("input", { className: "dbw-input", type: "number", min: 0, max: 1, step: 0.05, value: draft.jitter, onChange: (e) => setField("jitter", e.target.value) }))),

            h(Row, { label: "作息预设", hint: "点一下只是把上面三个框填好，**不会**自动保存 —— 还要点「保存设置」。" },
              h("div", { style: { display: "flex", gap: "8px", flexWrap: "wrap" } },
                SCHEDULE_PRESETS.map((preset) =>
                  h("button", {
                    key: preset.key, className: "dbw-btn dbw-btn2", type: "button", disabled: notReady,
                    onClick: () => applyPreset(preset),
                  }, preset.label)))),

          h("div", { className: "dbw-group" }, "模型路由（可选）"),
          h("div", { className: "dbw-rows" },
            h(Row, { label: "provider", hint: "留空 = 用宿主默认；例：deepseek-account" },
              h("input", {
                className: "dbw-input", type: "text", placeholder: "留空 = 宿主默认",
                value: draft.llmProvider, disabled: notReady,
                onChange: (e) => setField("llmProvider", e.target.value),
              })),
            h(Row, { label: "model", hint: "留空 = 用宿主默认；例：deepseek-flash" },
              h("input", {
                className: "dbw-input", type: "text", placeholder: "留空 = 宿主默认",
                value: draft.llmModel, disabled: notReady,
                onChange: (e) => setField("llmModel", e.target.value),
              })),
            h("div", { className: "dbw-hint" },
              "留空 = 用宿主默认；填 provider 与 model（例：deepseek-account / deepseek-flash）。路由不对时她会降级成只读，并在审计里记 llm-route-missing")),

          h("div", { className: "dbw-group" }, "每日上限"),
          h("div", { className: "dbw-rows" },
            h(Row, {
              key: "cap-dynamic", label: "发动态" + (draft.caps.dynamic === "" ? "（不限）" : ""),
              hint: "留空 = 不限；填 0 = 禁止",
            },
              h("input", {
                className: "dbw-input", type: "number", min: 0, max: 1000, placeholder: "2",
                value: draft.caps.dynamic ?? "",
                onChange: (e) => setCap("dynamic", e.target.value),
              })),
            h("div", { className: "dbw-hint" },
              "其余动作（评论 / 回复 / 点赞 / 关注 / 私信）不设上限；如需限制，可编辑 schedule.json 的 caps。"),
            h("div", { className: "dbw-hint" },
              "上限只是自控；真正拦住高频的是 token 预算与两次写之间的间隔（120 秒）。")),


          h("div", { className: "dbw-group" }, "人设"),
          h("div", { className: "dbw-rows" },
            personaAvailable === false
              ? h("div", { className: "dbw-hint" }, "结构化人设未就绪（core/persona.js 的 parseSections / writeSections 还没落盘）")
              : null,
            PERSONA_FIELDS.map((field) =>
              h(Row, { key: field.key, label: field.label, hint: field.hint },
                field.multiline
                  ? h("textarea", {
                    className: "dbw-input dbw-wide",
                    style: { height: field.key === "personality" ? 66 : 110, padding: 8, lineHeight: "18px", resize: "vertical" },
                    placeholder: "一行一项，保存时会按行拆分",
                    value: personaDraft === null ? "" : (personaDraft[field.key] ?? ""),
                    disabled: disabled || personaAvailable === false,
                    onChange: (e) => setPersonaDraft((d) => ({ ...d, [field.key]: e.target.value })),
                  })
                  : h("input", {
                    className: "dbw-input dbw-wide", type: "text", maxLength: 200,
                    placeholder: "一句话说完",
                    value: personaDraft === null ? "" : (personaDraft[field.key] ?? ""),
                    disabled: disabled || personaAvailable === false,
                    onChange: (e) => setPersonaDraft((d) => ({ ...d, [field.key]: e.target.value })),
                  }))),
            h("details", null,
              h("summary", { className: "dbw-hint", style: { cursor: "pointer" } }, "备注（只读，这里只放给人看的说明）"),
              h("pre", { className: "dbw-mono", style: { whiteSpace: "pre-wrap", margin: 0 } },
                asText(personaNotes) || "（没有备注）"))),

          h("div", { className: "dbw-actions" },
            h("button", { className: "dbw-btn", onClick: save, disabled: disabled }, busy === "save" ? "保存中…" : "保存设置"),
            h("button", { className: "dbw-btn", onClick: saveProfile, disabled: disabled || profile.available === false }, busy === "profile" ? "保存中…" : "保存身份"),
            h("button", { className: "dbw-btn", onClick: savePersona, disabled: disabled }, busy === "persona" ? "保存中…" : "保存人设"),
            h("button", { className: "dbw-btn", onClick: wake, disabled: disabled }, busy === "wake" ? "叫醒中…" : "现在醒一次"),
            h("button", { className: "dbw-btn dbw-btn2", onClick: load, disabled: !!busy }, "重新读取")),

          err ? h("div", { className: "dbw-err" }, err) : null,
          out ? h("div", { className: "dbw-out" }, out) : null,

          h("div", { className: "dbw-group" }, "审计（最近 20 条）"),
          h("div", { className: "dbw-rows" },
            audit.length === 0
              ? h("div", { className: "dbw-hint" }, "（还没有记录）")
              : audit.map((entry, index) =>
                h("div", { className: "dbw-row", key: "audit-" + index },
                  h("div", null,
                    h("div", { className: "dbw-hint" }, asText(entry?.at) || "—"),
                    h("div", { className: "dbw-mono" }, asText(entry?.tool) + " · " + asText(entry?.why)))))),


          h("div", { className: "dbw-group" }, "热梗库"),
          h("div", { className: "dbw-rows" },
            h("div", { className: "dbw-hint" }, memeReady ? memeStatus : "热梗库未就绪（core/memes.js 还没落盘）"),
            memeReady && memeItems.length === 0
              ? h("div", { className: "dbw-hint" }, "（列表为空，点下面「立即刷新」拉一批）")
              : null,
            memeItems.map((item, index) =>
              h("div", { className: "dbw-row", key: "meme-" + index },
                h("div", null,
                  h("div", { className: "dbw-label" }, asText(item?.meme) || "—"),
                  h("div", { className: "dbw-hint" }, asText(item?.meaning) || "（没写意思，她不会用）")),
                h("div", { className: "dbw-mono" }, "用过 " + asText(item?.seen) + " 次"))),
            h("div", { className: "dbw-actions" },
              h("button", {
                className: "dbw-btn", onClick: refreshMemes, disabled: !!busy || !memeReady,
              }, busy === "meme" ? "刷新中…" : "立即刷新"))),

          h("div", { className: "dbw-group" }, "今日日记"),
          h("pre", { className: "dbw-mono", style: { whiteSpace: "pre-wrap", margin: 0 } }, asText(state.diaryToday) || "（今天还没有日记）"));
      }
      // ── 设置入口：一个 section，里面两个标签页 ─────────────────────────────────
      // 用户要求侧栏只留一个「B站账号」，进去后「账号 / 她」各是一整页（不再是一条长滚动）。
      // 子组件内部逻辑一行没改：各自 mount 时自己拉数据；切标签 = 重新 mount = 重新拉一次，
      // 这是预期行为（不做缓存，也就不会出现"切回去还是旧数据"）。默认每次进来都是「账号」。
      const SETTINGS_TABS = [
        { key: "account", label: "账号" },
        { key: "self", label: "她" },
      ];

      function BiliSettings() {
        useStyleOnce();
        const [tab, setTab] = useState("account");
        return h("div", { className: "dbw" },
          h("div", { className: "dbw-tabs", role: "tablist" },
            SETTINGS_TABS.map((item) =>
              h("button", {
                key: item.key,
                type: "button",
                role: "tab",
                "aria-selected": tab === item.key,
                className: "dbw-tab" + (tab === item.key ? " dbw-tab-active" : ""),
                onClick: () => setTab(item.key),
              }, item.label))),
          tab === "account" ? h(BiliSection) : h(SelfSection));
      }

      const inject = ["slots"];
      const SLOT_ID = "bili";
      const NAV_LABEL = "B站账号";

      function apply(ctx) {
        // **只注册一个** section：侧栏里就一个「B站账号」，两页由里面的标签切换。
        ctx.effect(
          () =>
            ctx.slots.inject("settings.section", () =>
              ctx.slots.register(
                { name: "settings.section", id: SLOT_ID, order: 9, label: () => NAV_LABEL },
                BiliSettings,
              ),
              "dsh-bili: settings section",
            ),
          "dsh-bili: settings section",
        );
      }

      exports.apply = apply;
      exports.inject = inject;
      exports.BiliSettings = BiliSettings;
      exports.BiliSection = BiliSection;
      exports.SelfSection = SelfSection;
      return module.exports;
    },
  });
}
