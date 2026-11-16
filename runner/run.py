"""Agent Reality Check: daily benchmark runner.

Standard library only (no pip install needed).

Commands:
  py runner/run.py check            test every key, model ID and data source
  py runner/run.py run              run the next day and rewrite site/data.js
  py runner/run.py run --mock       full pipeline with fake models/quotes (no keys, no network)
  py runner/run.py go-live          wipe practice runs; the next `run` is real day 1
  py runner/run.py status           show mode, day and next task

Modes:
  practice  (default) runs are real but the site keeps the SAMPLE labels and
            evidence goes to runs/practice/. Use this for the 3-5 internal days.
  live      after `go-live`. Site labels drop, evidence goes to runs/live/.
"""
import argparse
import datetime
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SITE_DATA = os.path.join(ROOT, "site", "data.js")
STATE_PATH = os.path.join(HERE, "state.json")
RUNS_DIR = os.path.join(ROOT, "runs")

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


# ----------------------------------------------------------------- utilities

def load_json(path, default=None):
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def save_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def load_env():
    env = {}
    p = os.path.join(HERE, ".env")
    if os.path.exists(p):
        with open(p, encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"').strip("'")
    for k, v in os.environ.items():  # real env vars (GitHub Actions secrets) win
        if v:
            env[k] = v
    return env


def clip(s, n=280):
    s = re.sub(r"\s+", " ", str(s)).strip()
    return s if len(s) <= n else s[: n - 1] + "…"


def fmt_num(x):
    if x is None:
        return "none"
    return ("%.9f" % x).rstrip("0").rstrip(".")


def today_iso():
    return datetime.date.today().isoformat()


class HttpError(Exception):
    def __init__(self, code, msg):
        super().__init__("HTTP %s: %s" % (code, msg))
        self.code, self.msg = code, msg


def http(method, url, headers=None, body=None, timeout=120, tries=4):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    h = {"User-Agent": "agent-reality-check/1.0", "Accept": "application/json"}
    if data is not None:
        h["Content-Type"] = "application/json"
    h.update(headers or {})
    for i in range(tries):
        req = urllib.request.Request(url, data=data, headers=h, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            txt = e.read().decode("utf-8", "replace")[:600]
            if e.code in (408, 429, 500, 502, 503, 504) and i < tries - 1:
                ra = e.headers.get("Retry-After")
                wait = int(ra) if ra and ra.isdigit() else 8 * 2 ** i
                print("    ... HTTP %s, retrying in %ss" % (e.code, min(wait, 90)))
                time.sleep(min(wait, 90))
                continue
            raise HttpError(e.code, txt)
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if i < tries - 1:
                time.sleep(5 * 2 ** i)
                continue
            raise HttpError(0, str(e))
    raise HttpError(0, "unreachable")


def redact(s, env):
    s = str(s)
    for k, v in env.items():
        if k.endswith("_KEY") and v and len(v) > 6:
            s = s.replace(v, "***")
    return s


# --------------------------------------------------------- data sources

def get_slot(env):
    url = "https://mainnet.helius-rpc.com/?api-key=" + urllib.parse.quote(env["HELIUS_API_KEY"])
    r = http("POST", url, body={"jsonrpc": "2.0", "id": 1, "method": "getSlot", "params": [{"commitment": "finalized"}]})
    if "result" not in r:
        raise HttpError(0, "Helius: %s" % r.get("error"))
    return int(r["result"])


def jup_quote(env, cfg, in_mint, out_mint, amount_raw, dex=None, direct=False):
    key = env.get("JUPITER_API_KEY")
    base = cfg["jupiter"]["keyedUrl"] if key else cfg["jupiter"]["freeUrl"]
    q = {"inputMint": in_mint, "outputMint": out_mint, "amount": str(amount_raw), "slippageBps": "50"}
    if dex:
        q["dexes"] = dex
    if direct:
        q["onlyDirectRoutes"] = "true"
    return http("GET", base + "?" + urllib.parse.urlencode(q), headers={"x-api-key": key} if key else {})


def slim_quote(q):
    route = []
    for step in q.get("routePlan") or []:
        si = step.get("swapInfo") or {}
        route.append({"dex": si.get("label"), "percent": step.get("percent")})
    return {
        "inAmount": q.get("inAmount"),
        "outAmount": q.get("outAmount"),
        "priceImpactPct": q.get("priceImpactPct"),
        "contextSlot": q.get("contextSlot"),
        "route": route,
    }


def quote_key(dex, direct):
    return "%s|%s" % ((dex or "auto").lower(), "direct" if direct else "any")


def take_snapshot(env, cfg, task):
    """Freeze every tool response before any model runs."""
    tok = cfg["tokens"]
    tin, tout = tok[task["in"]], tok[task["out"]]
    raw = int(round(task["amount"] * 10 ** tin["decimals"]))
    slot = get_slot(env)
    variants = [(None, False), (None, True)] + [(d, False) for d in cfg["jupiter"]["dexes"]]
    quotes = {}
    for dex, direct in variants:
        k = quote_key(dex, direct)
        try:
            q = jup_quote(env, cfg, tin["mint"], tout["mint"], raw, dex, direct)
            quotes[k] = slim_quote(q) if q.get("outAmount") else {"error": clip(q.get("error") or "no route", 160)}
        except HttpError as e:
            quotes[k] = {"error": clip("quote unavailable (%s)" % e.code, 160)}
        print("    quote %-22s %s" % (k, quotes[k].get("outAmount") or quotes[k].get("error")))
        time.sleep(1.2)  # stay inside the free Jupiter rate limit
    return finish_snapshot(cfg, task, slot, raw, quotes)


def finish_snapshot(cfg, task, slot, raw, quotes):
    tout = cfg["tokens"][task["out"]]
    ok = {k: v for k, v in quotes.items() if v.get("outAmount")}
    if not ok:
        raise SystemExit("No quote could be captured. Nothing was run. Try again in a few minutes.")
    best_k = max(ok, key=lambda k: int(ok[k]["outAmount"]))
    gt = int(ok[best_k]["outAmount"]) / 10 ** tout["decimals"]
    return {
        "slot": slot,
        "capturedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"),
        "task": task,
        "amountRaw": raw,
        "quotes": quotes,
        "best": {"key": best_k, "outAmount": ok[best_k]["outAmount"], "route": ok[best_k]["route"]},
        "groundTruth": round(gt, tout["decimals"]),
    }


def mock_snapshot(cfg, task):
    tin, tout = task["in"], task["out"]
    raw = int(round(task["amount"] * 10 ** cfg["tokens"][tin]["decimals"]))
    base = int(0.3409371 * 10 ** cfg["tokens"][tout]["decimals"])
    quotes = {
        quote_key(None, False): {"inAmount": str(raw), "outAmount": str(base), "priceImpactPct": "0.0002", "contextSlot": 312448901,
                                 "route": [{"dex": "Whirlpool", "percent": 60}, {"dex": "Raydium CLMM", "percent": 40}]},
        quote_key(None, True): {"inAmount": str(raw), "outAmount": str(base - 900), "priceImpactPct": "0.0003", "contextSlot": 312448901,
                                "route": [{"dex": "Whirlpool", "percent": 100}]},
        quote_key("Raydium", False): {"inAmount": str(raw), "outAmount": str(int(base * 0.9991)), "priceImpactPct": "0.0009", "contextSlot": 312448901,
                                      "route": [{"dex": "Raydium", "percent": 100}]},
        quote_key("Phoenix", False): {"error": "no route"},
    }
    return finish_snapshot(cfg, task, 312448901, raw, quotes)


# ------------------------------------------------------------- the tools

TOOLS = [
    {"type": "function", "function": {
        "name": "get_token_info",
        "description": "Look up a Solana token by symbol. Returns its mint address and decimals.",
        "parameters": {"type": "object", "properties": {"symbol": {"type": "string", "description": "Token symbol, e.g. USDC"}}, "required": ["symbol"]}}},
    {"type": "function", "function": {
        "name": "list_dexes",
        "description": "List the DEX names that get_quote accepts in its `dex` parameter.",
        "parameters": {"type": "object", "properties": {}}}},
    {"type": "function", "function": {
        "name": "get_quote",
        "description": "Get a swap quote from the Jupiter aggregator. `amount` is in the input token's smallest unit (raw integer, apply decimals). Returns outAmount in the output token's smallest unit, price impact and the route.",
        "parameters": {"type": "object", "properties": {
            "input_mint": {"type": "string"},
            "output_mint": {"type": "string"},
            "amount": {"type": "integer", "description": "Raw amount in smallest units"},
            "dex": {"type": "string", "description": "Optional. Restrict routing to one DEX from list_dexes. Omit for the full aggregator."},
            "direct_only": {"type": "boolean", "description": "Optional. Only single-hop routes."}},
            "required": ["input_mint", "output_mint", "amount"]}}},
    {"type": "function", "function": {
        "name": "submit_answer",
        "description": "Submit your final answer. Call exactly once, at the end.",
        "parameters": {"type": "object", "properties": {
            "amount": {"type": "number", "description": "Quoted output amount in whole output-token units (not raw units), before any slippage tolerance."},
            "route": {"type": "string", "description": "Short description of the route"}},
            "required": ["amount", "route"]}}},
]
TOOL_NAMES = [t["function"]["name"] for t in TOOLS if t["function"]["name"] != "submit_answer"]

SYSTEM = ("You are an onchain research agent. You can only learn about the world through the tools provided. "
          "Work step by step, call tools as needed, and finish by calling submit_answer exactly once.")


def task_prompt(task):
    return ("You have %s %s on Solana. Using only the provided tools, find the route that returns the most %s. "
            "Report the quoted output amount before any slippage tolerance, in whole %s (not raw units), "
            "exactly as quoted: do not round, do not subtract fees or buffers. Then call submit_answer."
            % (fmt_num(task["amount"]), task["in"], task["out"], task["out"]))


def task_title(task):
    return "Swap %s %s to %s" % (fmt_num(task["amount"]), task["in"], task["out"])


def run_tool(name, args, snap, cfg):
    if not isinstance(args, dict):
        return {"error": "Invalid call: arguments are not a JSON object"}
    if name == "get_token_info":
        sym = str(args.get("symbol", "")).strip().upper()
        for s, t in cfg["tokens"].items():
            if s.upper() == sym:
                return {"symbol": s, "mint": t["mint"], "decimals": t["decimals"]}
        return {"error": "Unknown token symbol: %s" % clip(sym, 30)}
    if name == "list_dexes":
        return {"dexes": cfg["jupiter"]["dexes"]}
    if name == "get_quote":
        missing = [k for k in ("input_mint", "output_mint", "amount") if args.get(k) in (None, "")]
        if missing:
            return {"error": "Invalid call: missing required parameter `%s`" % missing[0]}
        try:
            amt = float(args["amount"])
        except (TypeError, ValueError):
            return {"error": "Invalid call: `amount` must be an integer"}
        task, tok = snap["task"], cfg["tokens"]
        same = (args["input_mint"] == tok[task["in"]]["mint"] and args["output_mint"] == tok[task["out"]]["mint"]
                and abs(amt - snap["amountRaw"]) < 0.5)
        if not same:
            return {"error": "No quote captured for these arguments at slot %s. Only frozen quotes are served." % snap["slot"]}
        dex = args.get("dex") or None
        if dex and dex.lower() not in [d.lower() for d in cfg["jupiter"]["dexes"]]:
            return {"error": "Unknown dex `%s`. Use list_dexes." % clip(dex, 40)}
        q = snap["quotes"].get(quote_key(dex, bool(args.get("direct_only"))))
        if not q:
            return {"error": "No quote captured for this dex/route combination at slot %s." % snap["slot"]}
        return dict(q) if "error" not in q else {"error": q["error"]}
    return {"error": "Unknown tool: %s" % clip(name, 40)}


def summarize(name, res, snap, cfg):
    if "error" in res:
        return clip(res["error"], 200)
    if name == "get_quote":
        out_dec = cfg["tokens"][snap["task"]["out"]]["decimals"]
        route = " → ".join("%s %s%%" % (r["dex"], r["percent"]) for r in res.get("route", []))
        return "outAmount %s raw (= %s %s) · impact %s · %s" % (
            res["outAmount"], fmt_num(int(res["outAmount"]) / 10 ** out_dec), snap["task"]["out"], res.get("priceImpactPct"), route)
    return clip(json.dumps(res, ensure_ascii=False), 200)


def compact_args(a):
    if not isinstance(a, dict):
        return clip(a, 120)
    parts = []
    for k, v in a.items():
        v = v[:6] + "…" if isinstance(v, str) and len(v) > 32 else v
        parts.append("%s: %s" % (k, json.dumps(v, ensure_ascii=False)))
    return clip("{ " + ", ".join(parts) + " }", 160)


# ------------------------------------------------------------- model calls

_last_call = {}


def chat(cfg, env, model, messages, tools=None):
    prov = cfg["providers"][model["provider"]]
    gap = prov.get("minIntervalSec", 0) - (time.time() - _last_call.get(model["provider"], 0))
    if gap > 0:
        time.sleep(gap)
    key = env.get(prov["keyEnv"])
    if not key:
        raise HttpError(0, "%s is missing in runner/.env" % prov["keyEnv"])
    headers = {"Authorization": "Bearer " + key}
    if model["provider"] == "openrouter":
        headers["X-Title"] = "Agent Reality Check"
    body = {"model": model["modelId"], "messages": messages, "tools": tools or TOOLS, "tool_choice": "auto", "temperature": 0}
    try:
        return http("POST", prov["base"].rstrip("/") + "/chat/completions", headers=headers, body=body)
    finally:
        _last_call[model["provider"]] = time.time()


class Mock:
    """Scripted fake models, one persona each, to test the pipeline offline."""
    PERSONAS = ["good", "buffer", "decimals", "noanswer", "above"]

    def __init__(self, cfg, snap):
        self.cfg, self.snap = cfg, snap

    def reply(self, model, messages):
        idx = [m["id"] for m in self.cfg["models"]].index(model["id"])
        persona = self.PERSONAS[idx % len(self.PERSONAS)]
        turn = sum(1 for m in messages if m["role"] == "assistant")
        t, tok = self.snap["task"], self.cfg["tokens"]
        gt = self.snap["groundTruth"]

        def call(name, args):
            return {"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": [
                {"id": "c%d" % turn, "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}}],
                "usage": {"prompt_tokens": 400, "completion_tokens": 40}}

        quote = {"input_mint": tok[t["in"]]["mint"], "output_mint": tok[t["out"]]["mint"], "amount": self.snap["amountRaw"]}
        if persona == "noanswer":
            return call("get_quote", {"input_mint": tok[t["in"]]["mint"], "output_mint": tok[t["out"]]["mint"]}) if turn < 3 else \
                {"choices": [{"message": {"role": "assistant", "content": "No route found."}}], "usage": {}}
        if turn == 0:
            return call("get_token_info", {"symbol": t["in"]})
        if turn == 1:
            return call("get_quote", quote)
        ans = {"good": gt, "buffer": round(gt * 0.9975, 6), "decimals": gt / 1000, "above": round(gt * 1.004, 6)}[persona]
        return call("submit_answer", {"amount": ans, "route": "aggregator best route"})


def run_model(cfg, env, model, snap, mock=None):
    max_steps = cfg["site"]["maxSteps"]
    msgs = [{"role": "system", "content": SYSTEM}, {"role": "user", "content": task_prompt(snap["task"])}]
    trace, raw = [], []
    steps, answer, route, status = 0, None, None, "no_answer"
    tok_in = tok_out = 0
    t0 = time.time()
    for _turn in range(max_steps + 3):
        try:
            resp = mock.reply(model, msgs) if mock else chat(cfg, env, model, msgs)
        except HttpError as e:
            trace.append({"t": "error", "x": clip("API error %s: %s" % (e.code, redact(e.msg, env)), 200)})
            status = "api_error"
            break
        raw.append(resp)
        u = resp.get("usage") or {}
        tok_in += u.get("prompt_tokens") or 0
        tok_out += u.get("completion_tokens") or 0
        choice = (resp.get("choices") or [{}])[0]
        msg = choice.get("message") or {}
        content = msg.get("content")
        if isinstance(content, list):
            content = " ".join(p.get("text", "") for p in content if isinstance(p, dict))
        if content and content.strip():
            trace.append({"t": "think", "x": clip(content)})
        calls = msg.get("tool_calls") or []
        if not calls:
            break
        msgs.append({"role": "assistant", "content": content or "", "tool_calls": calls})
        done = False
        for c in calls:
            fn = c.get("function") or {}
            name = fn.get("name", "?")
            argstr = fn.get("arguments")
            try:
                args = json.loads(argstr) if isinstance(argstr, str) else (argstr or {})
            except ValueError:
                args = None
            if name == "submit_answer" and isinstance(args, dict) and not done:
                try:
                    answer = float(args.get("amount"))
                except (TypeError, ValueError):
                    answer = None
                route = clip(args.get("route") or "", 160)
                trace.append({"t": "answer", "x": "%s %s%s" % (fmt_num(answer), snap["task"]["out"], (" via " + route) if route else "")})
                status = "answered" if answer is not None else "bad_answer"
                result, done = {"ok": True}, True
            else:
                steps += 1
                trace.append({"t": "tool", "x": "%s(%s)" % (name, compact_args(args))})
                result = {"error": "Step limit reached"} if steps > max_steps else run_tool(name, args, snap, cfg)
                trace.append({"t": "error" if "error" in result else "result", "x": summarize(name, result, snap, cfg)})
            msgs.append({"role": "tool", "tool_call_id": c.get("id") or name, "content": json.dumps(result)})
        if done or steps >= max_steps:
            if not done:
                status = "step_limit"
            break
    if status == "step_limit" and not mock:
        # Out of tool steps: one last turn where the only allowed action is submitting.
        msgs.append({"role": "user", "content": "Step limit reached. No more tools. Call submit_answer now with your best answer."})
        try:
            resp = chat(cfg, env, model, msgs, tools=[t for t in TOOLS if t["function"]["name"] == "submit_answer"])
            raw.append(resp)
            u = resp.get("usage") or {}
            tok_in += u.get("prompt_tokens") or 0
            tok_out += u.get("completion_tokens") or 0
            msg = ((resp.get("choices") or [{}])[0].get("message")) or {}
            for c in msg.get("tool_calls") or []:
                fn = c.get("function") or {}
                if fn.get("name") != "submit_answer":
                    continue
                try:
                    args = json.loads(fn.get("arguments") or "{}")
                    answer = float(args.get("amount"))
                except (TypeError, ValueError):
                    answer = None
                    args = {}
                route = clip(args.get("route") or "", 160)
                if answer is not None:
                    trace.append({"t": "answer", "x": "%s %s%s (after step limit)" % (fmt_num(answer), snap["task"]["out"], (" via " + route) if route else "")})
                    status = "answered"
                break
        except HttpError as e:
            trace.append({"t": "error", "x": clip("API error %s: %s" % (e.code, redact(e.msg, env)), 200)})
    latency = round(time.time() - t0, 1)
    if status == "no_answer" and not any(x["t"] == "answer" for x in trace):
        trace.append({"t": "answer", "x": "No answer submitted."})
    price = model.get("usdPerMTok") or [0, 0]
    cost = round((tok_in * price[0] + tok_out * price[1]) / 1e6, 4)
    return {
        "model": model["id"], "modelId": model["modelId"], "answer": answer, "route": route, "status": status,
        "steps": min(steps, max_steps), "latency": latency, "cost": cost, "tokens": [tok_in, tok_out],
        "trace": trace, "messages": msgs, "raw": raw,
    }


# ----------------------------------------------------------------- scoring

def score(answer, gt, thr):
    if answer is None or not gt:
        return None, False
    d = (answer - gt) / gt * 100
    return d, (d <= 1e-9 and d >= -thr - 1e-9)


def fail_reason(r, d):
    if r["status"] == "api_error":
        return "provider error", "Provider API failed (run voided)"
    if r["answer"] is None:
        return "no answer", "No answer after %d steps" % r["steps"] if r["status"] == "step_limit" else "Gave up without an answer"
    if d > 0:
        return "above best", "Answered %+.2f%% above the best reachable output" % d
    if d < -50:
        return "outside threshold", "Answer off by %.1f%% (likely a units/decimals mistake)" % d
    return "outside threshold", "Answered %.2f%% below the best route" % d


# ---------------------------------------------------------------- data.js

def write_data_js(cfg, state, day_rec):
    models = []
    for m in cfg["models"]:
        prov = cfg["providers"][m["provider"]]
        models.append({"id": m["id"], "name": m["name"], "vendor": m["vendor"], "color": m["color"],
                       "modelId": m["modelId"], "provider": prov["label"], "params": "temperature 0",
                       "failure": common_failure(state, m["id"])})
    t = day_rec["task"]
    snap = day_rec["snapshot"]
    fotd = None
    fails_today = [f for f in state["fails"] if f["day"] == day_rec["day"] and f["rule"] != "provider error"]
    if fails_today:
        worst = sorted(fails_today, key=lambda f: -abs(f.get("delta") or 1e9))[0]
        fotd = {"model": worst["model"], "text": worst["title"] + "."}
    data = {
        "sample": state["mode"] != "live",
        "config": {k: cfg["site"][k] for k in ("repo", "xHandle", "passThresholdPct", "maxSteps", "methodologyPath")},
        "day": day_rec["day"],
        "totalDays": cfg["site"]["totalDays"],
        "date": day_rec["date"],
        "category": "Swap routing",
        "stats": {"storedPct": 100},
        "today": {
            "title": task_title(t),
            "prompt": task_prompt(t),
            "groundTruth": snap["groundTruth"],
            "unit": t["out"],
            "source": "Jupiter quote, snapshotted",
            "slot": "{:,}".format(snap["slot"]),
            "verify": "Ground truth and every tool response are snapshotted once at this slot, before any model runs. "
                      "All models see the same frozen responses, so price drift cannot affect the score. "
                      "The quote itself is an offchain aggregator response; a swap-simulation cross-check is planned.",
            "tools": TOOL_NAMES,
        },
        "models": models,
        "results": [{k: r[k] for k in ("model", "answer", "cost", "steps", "latency")} for r in day_rec["results"]],
        "failOfTheDay": fotd,
        "traces": {r["model"]: r["trace"] for r in day_rec["results"]},
        "log": state["log"],
        "fails": [{k: f[k] for k in ("day", "model", "category", "title", "rule", "gt", "answer", "unit")}
                  for f in sorted(state["fails"], key=lambda f: -f["day"]) if f["rule"] != "provider error"][:24],
        "roadmap": cfg["roadmap"],
    }
    header = ("// Agent Reality Check: data file. GENERATED by runner/run.py on %s. Do not edit by hand;\n"
              "// edit runner/state.json or runner/config.json and re-run instead.\n" % day_rec["date"])
    tmp = SITE_DATA + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(header + "window.ARC_DATA = " + json.dumps(data, indent=2, ensure_ascii=False) + ";\n")
    os.replace(tmp, SITE_DATA)


def common_failure(state, mid):
    mine = [f for f in state["fails"] if f["model"] == mid and f["rule"] != "provider error"]
    if len(mine) < 2:
        return "Not enough data yet"
    counts = {}
    for f in mine:
        counts[f["rule"]] = counts.get(f["rule"], 0) + 1
    rule, n = max(counts.items(), key=lambda kv: kv[1])
    return "Most often: %s (%d of %d fails)" % (rule, n, len(mine))


# ---------------------------------------------------------------- commands

def new_state(mode):
    return {"mode": mode, "day": 0, "log": {}, "fails": [], "history": []}


def cmd_status(cfg, tasks, state):
    nxt = state["day"] + 1
    t = pick_task(tasks, nxt, state["mode"])
    print("mode: %s | last day run: %s | next: day %s -> %s" % (state["mode"], state["day"], nxt, task_title(t) if t else "no task defined"))


def pick_task(tasks, day, mode):
    by_day = {t["day"]: t for t in tasks}
    if mode == "practice":  # practice cycles through the defined swap tasks
        return tasks[(day - 1) % len(tasks)]
    return by_day.get(day)


def cmd_run(cfg, tasks, state, env, mock, out_path=None):
    day = state["day"] + 1
    task = pick_task(tasks, day, state["mode"])
    if not task:
        raise SystemExit("Day %d has no task in runner/tasks.json. Days 16+ (Honeypot detection) need a new task type that is not built yet." % day)
    if task["type"] != "swap":
        raise SystemExit("Task type %s is not supported yet." % task["type"])
    if not mock:
        missing = [k for k in ["HELIUS_API_KEY"] + sorted({cfg["providers"][m["provider"]]["keyEnv"] for m in cfg["models"]}) if not env.get(k)]
        if missing:
            raise SystemExit("Missing in runner/.env: " + ", ".join(missing))

    print("Day %d (%s) · %s" % (day, state["mode"], task_title(task)))
    print("  1/3 freezing quotes and slot ...")
    snap = mock_snapshot(cfg, task) if mock else take_snapshot(env, cfg, task)
    print("    slot %s · ground truth %s %s" % (snap["slot"], fmt_num(snap["groundTruth"]), task["out"]))

    print("  2/3 running models ...")
    mk = Mock(cfg, snap) if mock else None
    thr = cfg["site"]["passThresholdPct"]
    results = []
    for m in cfg["models"]:
        r = run_model(cfg, env, m, snap, mk)
        d, ok = score(r["answer"], snap["groundTruth"], thr)
        r["delta"], r["pass"] = d, ok
        print("    %-9s %-12s %s" % (m["name"], fmt_num(r["answer"]), "PASS" if ok else ("VOID (api error)" if r["status"] == "api_error" else "FAIL")))
        results.append(r)

    print("  3/3 writing results ...")
    date = today_iso()
    for m in cfg["models"]:
        L = state["log"].setdefault(m["id"], {"pass": "-" * (day - 1), "cost": [0] * (day - 1)})
        L["pass"] = L["pass"].ljust(day - 1, "-")[: day - 1]
        L["cost"] = (L["cost"] + [0] * day)[: day - 1]
    for r in results:
        L = state["log"][r["model"]]
        L["pass"] += "-" if r["status"] == "api_error" else ("1" if r["pass"] else "0")
        L["cost"].append(r["cost"])
        if not r["pass"]:
            rule, title = fail_reason(r, r["delta"])
            state["fails"].append({"day": day, "model": r["model"], "category": "Swap routing", "title": title, "rule": rule,
                                   "gt": snap["groundTruth"], "answer": r["answer"], "unit": task["out"], "delta": r["delta"]})
    state["day"] = day
    day_rec = {"day": day, "date": date, "task": task, "snapshot": snap,
               "results": [{k: v for k, v in r.items() if k not in ("messages", "raw")} for r in results]}
    state["history"].append({"day": day, "date": date, "title": task_title(task), "gt": snap["groundTruth"],
                             "passes": sum(1 for r in results if r["pass"])})

    evidence = {"day": day, "date": date, "mode": state["mode"], "system": SYSTEM, "prompt": task_prompt(task),
                "tools": TOOLS, "snapshot": snap, "results": results}
    if out_path:  # mock/test runs: never touch real state, site or runs
        save_json(os.path.join(out_path, "state.json"), state)
        save_json(os.path.join(out_path, "evidence-day-%02d.json" % day), evidence)
        global SITE_DATA
        SITE_DATA = os.path.join(out_path, "data.js")
        write_data_js(cfg, state, day_rec)
        print("Mock output written to %s" % out_path)
        return
    save_json(os.path.join(RUNS_DIR, state["mode"], "day-%02d.json" % day), evidence)
    save_json(STATE_PATH, state)
    write_data_js(cfg, state, day_rec)
    print("Done. site/data.js updated; evidence in runs/%s/day-%02d.json" % (state["mode"], day))


def cmd_check(cfg, env):
    ok = True
    print("Keys in runner/.env:")
    needed = ["HELIUS_API_KEY"] + sorted({p["keyEnv"] for p in cfg["providers"].values()})
    for k in needed:
        print("  %-20s %s" % (k, "set" if env.get(k) else "MISSING"))
        ok &= bool(env.get(k))

    print("Helius (slot):")
    try:
        print("  OK, finalized slot %s" % get_slot(env))
    except Exception as e:
        ok = False
        print("  FAIL %s" % redact(e, env))

    print("Jupiter (quote 1 USDC -> SOL):")
    try:
        t = cfg["tokens"]
        q = jup_quote(env, cfg, t["USDC"]["mint"], t["SOL"]["mint"], 1000000)
        print("  OK, outAmount %s lamports" % q.get("outAmount") if q.get("outAmount") else "  FAIL %s" % q)
    except Exception as e:
        ok = False
        print("  FAIL %s (if this says 401, get a free key at portal.jup.ag and add JUPITER_API_KEY)" % redact(e, env))

    print("Models (one tiny tool-call test each):")
    probe = [{"role": "user", "content": "Call get_token_info for USDC."}]
    for m in cfg["models"]:
        try:
            r = chat(cfg, env, m, probe)
            msg = (r.get("choices") or [{}])[0].get("message") or {}
            tc = msg.get("tool_calls")
            print("  %-9s %-46s %s" % (m["name"], m["modelId"], "OK (tool call)" if tc else "WARN answered without a tool call"))
        except Exception as e:
            ok = False
            print("  %-9s %-46s FAIL %s" % (m["name"], m["modelId"], clip(redact(e, env), 160)))

    if env.get("OPENROUTER_API_KEY"):
        try:
            lst = http("GET", "https://openrouter.ai/api/v1/models").get("data", [])
            free = [x["id"] for x in lst if x["id"].endswith(":free") and "tools" in (x.get("supported_parameters") or [])]
            print("Free OpenRouter models with tool support right now (%d):" % len(free))
            for x in sorted(free)[:40]:
                print("  " + x)
        except Exception:
            pass
    print("\nAll good." if ok else "\nFix the FAIL lines above, then run check again.")


def main():
    ap = argparse.ArgumentParser(description="Agent Reality Check runner")
    ap.add_argument("command", choices=["check", "run", "go-live", "status"])
    ap.add_argument("--mock", action="store_true", help="fake models and quotes, writes to --out only")
    ap.add_argument("--out", help="output folder for --mock runs")
    a = ap.parse_args()

    cfg = load_json(os.path.join(HERE, "config.json"))
    tasks = load_json(os.path.join(HERE, "tasks.json"))["tasks"]
    env = load_env()

    if a.command == "check":
        return cmd_check(cfg, env)
    if a.mock:
        out = a.out or os.path.join(HERE, "mock-out")
        st = load_json(os.path.join(out, "state.json")) or new_state("practice")
        return cmd_run(cfg, tasks, st, env, True, out)

    state = load_json(STATE_PATH) or new_state("practice")
    if a.command == "status":
        return cmd_status(cfg, tasks, state)
    if a.command == "go-live":
        if state["mode"] == "live" and state["day"] > 0:
            raise SystemExit("Already live at day %d. Refusing to reset." % state["day"])
        save_json(STATE_PATH, new_state("live"))
        print("Live mode on. Next `run` is day 1. Practice evidence stays in runs/practice/.")
        return
    cmd_run(cfg, tasks, state, env, False)


if __name__ == "__main__":
    main()
