var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var RelayDO = class {
  static {
    __name(this, "RelayDO");
  }
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.hub = null;
    this.pending = /* @__PURE__ */ new Map();
  }
  /** 手机页面/网关错误时的可读引导页（与 Node 版同口径） */
  guide(status, title) {
    return new Response(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#17181c;color:#cfd3dc;font-family:system-ui;display:grid;place-items:center;height:100vh"><div style="text-align:center"><p>\u{1F4E1} ' + title + '</p><p style="opacity:.6;font-size:14px">\u8BF7\u6253\u5F00\u7535\u8111\u7AEF AgentHub\u300C\u624B\u673A\u67E5\u770B\u300D\uFF0C\u786E\u8BA4\u670D\u52A1\u4E0E\u4E2D\u7EE7\u5DF2\u5F00\u542F\u540E\u91CD\u65B0\u626B\u7801</p></div></body>',
      { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
    );
  }
  async fetch(req) {
    const url = new URL(req.url);
    if (req.headers.get("Upgrade") === "websocket") {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      if (this.hub) {
        try {
          this.hub.close(1e3, "replaced");
        } catch {
        }
      }
      this.hub = pair[1];
      this.hub.send(JSON.stringify({ type: "hello-ok" }));
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (!this.hub) return this.guide(502, "\u684C\u9762\u7AEF\u4E0D\u5728\u7EBF");
    const id = crypto.randomUUID();
    let body = null;
    if (req.method === "POST") {
      const b = await req.text();
      if (b.length > 256 * 1024) return new Response("too large", { status: 413 });
      body = b;
    }
    const pack = {
      type: "req",
      id,
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: { "content-type": req.headers.get("content-type") ?? "" },
      body
    };
    const resp = await new Promise((resolve) => {
      this.pending.set(id, resolve);
      try {
        this.hub.send(JSON.stringify(pack));
      } catch {
        this.pending.delete(id);
        resolve({ status: 502, headers: {}, body: '{"ok":false,"message":"\u8F6C\u53D1\u5931\u8D25"}' });
        return;
      }
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          resolve({ status: 504, headers: {}, body: '{"ok":false,"message":"\u684C\u9762\u7AEF\u54CD\u5E94\u8D85\u65F6"}' });
        }
      }, 2e4);
    });
    const headers = new Headers({ "Content-Type": resp.headers?.["content-type"] ?? "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return new Response(resp.body ?? "", { status: resp.status ?? 502, headers });
  }
  /** AgentHub 回包（hibernatable 唤醒入口） */
  async webSocketMessage(ws, message) {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    if (msg.type === "resp" && msg.id && this.pending.has(msg.id)) {
      const resolve = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      resolve({ status: msg.status, headers: msg.headers, body: msg.body });
    }
  }
  async webSocketClose(ws) {
    if (this.hub === ws) this.hub = null;
  }
};
var worker_default = {
  /** 手机与 AgentHub 的所有请求统一入口：按 ?t=token 确定性路由到 DO */
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/relay-info") {
      return new Response(JSON.stringify({ ok: true, ts: Date.now(), note: "agenthub relay (workers), per-token DO routing" }), {
        headers: { "content-type": "application/json; charset=utf-8" }
      });
    }
    const t = url.searchParams.get("t") ?? "";
    if (!t || !/^[0-9a-f]{16,64}$/.test(t)) {
      return new Response(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="background:#17181c;color:#cfd3dc;font-family:system-ui;display:grid;place-items:center;height:100vh"><div style="text-align:center"><p>\u{1F4E1} \u7F3A\u5C11\u914D\u5BF9\u51ED\u636E</p><p style="opacity:.6;font-size:14px">\u8BF7\u56DE\u684C\u9762\u7AEF AgentHub\u300C\u624B\u673A\u67E5\u770B\u300D\u91CD\u65B0\u626B\u7801</p></div></body>',
        { status: 401, headers: { "content-type": "text/html; charset=utf-8" } }
      );
    }
    const doStub = env.RELAY.get(env.RELAY.idFromName(t));
    return doStub.fetch(req);
  }
};

// C:/Users/zhangdy/AppData/Local/npm-cache/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// C:/Users/zhangdy/AppData/Local/npm-cache/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    const body = JSON.stringify(error);
    const headers = {
      "Content-Type": "application/json",
      "MF-Experimental-Error-Stack": "true"
    };
    const encoded = encodeURIComponent(body);
    if (encoded.length <= 8192) {
      headers["MF-Experimental-Error-Stack-Payload"] = encoded;
    }
    return new Response(body, { status: 500, headers });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// .wrangler/tmp/bundle-s36CG1/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = worker_default;

// C:/Users/zhangdy/AppData/Local/npm-cache/_npx/d77349f55c2be1c0/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// .wrangler/tmp/bundle-s36CG1/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  scheduledTime;
  cron;
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  RelayDO,
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=worker.js.map
