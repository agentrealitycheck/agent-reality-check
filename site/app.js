(function () {
  "use strict";

  var D = window.ARC_DATA || {};
  var NS = "http://www.w3.org/2000/svg";
  var mqRM = window.matchMedia ? window.matchMedia("(prefers-reduced-motion: reduce)") : { matches: false };
  var mqSM = window.matchMedia ? window.matchMedia("(max-width: 600px)") : { matches: false };
  var RM = !!mqRM.matches;

  // ---------- helpers ----------
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  // SVG element builder. fill/stroke/stop-color values that use var(--x) go into
  // style, because presentation attributes cannot resolve CSS custom properties.
  function svg(tag, attrs, parent) {
    var n = document.createElementNS(NS, tag);
    for (var k in attrs) {
      var v = attrs[k];
      if (v == null) continue;
      if (typeof v === "string" && v.indexOf("var(") === 0 && (k === "fill" || k === "stroke" || k === "stop-color")) n.style.setProperty(k, v);
      else n.setAttribute(k, v);
    }
    if (parent) parent.appendChild(n);
    return n;
  }
  function text(parent, attrs, str) { var t = svg("text", attrs, parent); t.textContent = str; return t; }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function num(v, d) { return isNum(v) ? v : d; }
  function fmtDelta(d) { return isNum(d) ? (d > 0 ? "+" : "") + d.toFixed(2) + "%" : "n/a"; }
  function fmtBps(d) { return isNum(d) ? (d > 0 ? "+" : "") + Math.round(d * 100) + " bps" : "n/a"; }
  function pct(v) { return isNum(v) ? (Math.round(v * 10) / 10) + "%" : "n/a"; }
  function usd(v, dec) { return "$" + num(v, 0).toFixed(dec == null ? 3 : dec); }
  function f2(v) { return v.toFixed(2); }
  function on(mq, fn) { if (mq.addEventListener) mq.addEventListener("change", fn); else if (mq.addListener) mq.addListener(fn); }
  function safe(name, fn) {
    try { fn(); } catch (e) { if (window.console) console.warn("[ARC] " + name + " skipped:", e); }
  }

  // ---------- normalise data ----------
  D.config = D.config || {};
  D.today = D.today || {};
  D.stats = D.stats || {};
  var THR = num(D.config.passThresholdPct, 1);
  var MAXSTEPS = Math.max(1, Math.round(num(D.config.maxSteps, 10)));
  var REPO = String(D.config.repo || "");
  var REPO_OK = /^https:\/\/github\.com\/[^\/]+\/[^\/]+/.test(REPO) && REPO.indexOf("YOUR_USERNAME") === -1;
  var DAY = Math.max(1, Math.round(num(D.day, 1)));
  var TOTAL = Math.max(DAY, Math.round(num(D.totalDays, 60)));
  var SAMPLE = !!D.sample;

  var models = (Array.isArray(D.models) ? D.models : []).filter(function (m) { return m && m.id; });
  var M = {};
  models.forEach(function (m) {
    m.name = m.name || m.id;
    m.color = /^#[0-9a-f]{3,8}$/i.test(m.color || "") ? m.color : "#8b98a5";
    M[m.id] = m;
  });
  function known(id) { return Object.prototype.hasOwnProperty.call(M, id); }

  var GT = isNum(D.today.groundTruth) && D.today.groundTruth !== 0 ? D.today.groundTruth : null;
  var UNIT = D.today.unit || "";
  var SLOT = D.today.slot != null ? D.today.slot : D.today.block;
  var SLOT_LABEL = D.today.slot != null ? "Slot" : "Block";
  function gtText() { return GT == null ? "n/a" : GT + " " + UNIT; }

  var traces = {};
  models.forEach(function (m) { traces[m.id] = Array.isArray((D.traces || {})[m.id]) ? D.traces[m.id] : []; });

  // results: drop unknown models and duplicates, add an empty row for any model without one
  var seen = {};
  var rawResults = (Array.isArray(D.results) ? D.results : []).filter(function (r) {
    if (!r || !known(r.model) || seen[r.model]) return false;
    seen[r.model] = true; return true;
  });
  models.forEach(function (m) { if (!seen[m.id]) rawResults.push({ model: m.id, answer: null, cost: 0, steps: 0, latency: 0 }); });

  function deltaOf(answer, gt) {
    if (!isNum(answer) || !isNum(gt) || gt === 0) return null;
    var d = ((answer - gt) / gt) * 100;
    return isFinite(d) ? d : null;
  }
  function passes(d) { return d != null && d <= 1e-9 && d >= -THR - 1e-9; }

  var results = rawResults.map(function (r) {
    var a = isNum(r.answer) ? r.answer : null;
    var d = deltaOf(a, GT);
    return { model: r.model, answer: a, delta: d, pass: passes(d), cost: num(r.cost, 0), steps: Math.max(0, num(r.steps, 0)), latency: Math.max(0, num(r.latency, 0)) };
  }).sort(function (a, b) {
    if (a.pass !== b.pass) return a.pass ? -1 : 1;
    var da = a.delta == null ? Infinity : Math.abs(a.delta), db = b.delta == null ? Infinity : Math.abs(b.delta);
    return (da === db ? 0 : da - db) || M[a.model].name.localeCompare(M[b.model].name);
  });
  var R = {};
  results.forEach(function (r) { R[r.model] = r; });
  var failCount = results.filter(function (r) { return !r.pass; }).length;
  var passCount = results.length - failCount;

  var fotd = D.failOfTheDay && known(D.failOfTheDay.model) ? D.failOfTheDay : null;
  var fails = (Array.isArray(D.fails) ? D.fails : []).filter(function (x) { return x && known(x.model); });

  // per-model series: cumulative pass rate from the daily log (fallback: legacy `history`)
  var S = {};
  var N_HIST = 0;
  models.forEach(function (m) {
    var L = (D.log || {})[m.id], rates = [], outcomes = [], costs = [], p = 0, a = 0;
    if (L && L.pass != null) {
      var arr = typeof L.pass === "string" ? L.pass.split("") : (Array.isArray(L.pass) ? L.pass : []);
      arr.forEach(function (c) {
        var o = (c === "1" || c === 1 || c === true) ? 1 : (c === "0" || c === 0 || c === false) ? 0 : null;
        outcomes.push(o);
        if (o != null) { a++; p += o; }
        rates.push(a ? (p / a) * 100 : null);
      });
      costs = (Array.isArray(L.cost) ? L.cost : []).filter(isNum);
    } else if (Array.isArray((D.history || {})[m.id])) {
      rates = D.history[m.id].map(function (v) { return isNum(v) ? v : null; });
    }
    var avg = costs.length ? costs.reduce(function (s, v) { return s + v; }, 0) / costs.length : num(m.avgCost, null);
    S[m.id] = { rates: rates, outcomes: outcomes, passes: p, attempts: a, costs: costs, avgCost: avg, hasLog: outcomes.length > 0 };
    N_HIST = Math.max(N_HIST, rates.length);
  });
  var FIRST_DAY = DAY - N_HIST + 1;
  // value of model id at global index i (series are right-aligned to today)
  function rateAt(id, i) { var r = S[id].rates, k = i - (N_HIST - r.length); return k >= 0 && k < r.length ? r[k] : null; }
  function latestRate(id) { for (var i = N_HIST - 1; i >= 0; i--) { var v = rateAt(id, i); if (v != null) return v; } return null; }

  // totals derived from the log
  var runsTotal = 0, computeUsd = 0, anyLog = false;
  models.forEach(function (m) {
    var s = S[m.id];
    if (s.hasLog) { anyLog = true; runsTotal += s.outcomes.filter(function (o) { return o != null; }).length; }
    computeUsd += s.costs.reduce(function (t, v) { return t + v; }, 0);
  });
  if (!anyLog) { runsTotal = num(D.stats.runsTotal, 0); computeUsd = num(D.stats.computeUsd, computeUsd); }
  var storedPct = num(D.stats.storedPct, num(D.stats.verifiedPct, 0));

  function runDate(day) {
    var t = Date.parse(D.date);
    if (!isFinite(t)) return null;
    var d = new Date(t - (DAY - day) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  function runUrl(day) { var d = runDate(day); return REPO_OK && d ? REPO.replace(/\/$/, "") + "/tree/main/runs/" + d : null; }

  // ---------- shared material defs (gradients reused by every hardware svg) ----------
  safe("defs", function () {
    var s = svg("svg", { width: 0, height: 0, "aria-hidden": "true", focusable: "false" });
    s.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    var defs = svg("defs", {}, s);
    function lin(id, x2, y2, stops) {
      var g = svg("linearGradient", { id: id, x1: 0, y1: 0, x2: x2, y2: y2 }, defs);
      stops.forEach(function (st) { svg("stop", { offset: st[0], "stop-color": st[1], "stop-opacity": st[2] == null ? 1 : st[2] }, g); });
    }
    function rad(id, stops) {
      var g = svg("radialGradient", { id: id }, defs);
      stops.forEach(function (st) { svg("stop", { offset: st[0], "stop-color": st[1], "stop-opacity": st[2] == null ? 1 : st[2] }, g); });
    }
    lin("arcShroud", 0, 1, [[0, "var(--shroud-1)"], [1, "var(--shroud-2)"]]);
    lin("arcSpreader", 0, 1, [[0, "#6b7785"], [0.4, "#3a4552"], [1, "#1a2129"]]);
    lin("arcFin", 1, 0, [[0, "#0a0e13"], [0.5, "var(--fin)"], [1, "#0a0e13"]]);
    lin("arcMetal", 1, 0, [[0, "#4e5862"], [0.5, "var(--metal)"], [1, "#454e58"]]);
    lin("arcLcd", 0, 1, [[0, "#0d2a1d"], [1, "#06120c"]]);
    rad("arcScorch", [[0, "#ffd29a", 0.95], [0.3, "#ff7b5a", 0.7], [0.7, "#3a1310", 0.6], [1, "#0d1117", 0]]);
    rad("arcGlow", [[0, "var(--pass)", 0.28], [1, "var(--pass)", 0]]);
    document.body.insertBefore(s, document.body.firstChild);
  });

  // ---------- chrome ----------
  safe("chrome", function () {
    if (SAMPLE) {
      $("sampleBanner").hidden = false;
      if (!document.querySelector('meta[name="robots"]')) {
        var meta = document.createElement("meta");
        meta.name = "robots"; meta.content = "noindex";
        document.head.appendChild(meta);
      }
      var th0 = document.querySelector("#resultsTable thead th");
      if (th0) th0.insertAdjacentHTML("beforeend", ' <span class="tag-sample">SAMPLE</span>');
      var cap = document.querySelector("#resultsTable caption");
      if (cap) cap.textContent = "Today's results per model (sample data)";
    }
    if (REPO_OK) $("ghLink").href = REPO;
    else { var gh = $("ghLink"); gh.removeAttribute("href"); gh.setAttribute("aria-disabled", "true"); gh.title = "Repo link coming at launch"; }
    Array.prototype.forEach.call(document.querySelectorAll(".thr"), function (el) { el.textContent = THR; });
    $("maxSteps").textContent = MAXSTEPS;
    $("nModels").textContent = models.length;
    var meth = $("methLink");
    if (REPO_OK) meth.href = REPO.replace(/\/$/, "") + (D.config.methodologyPath || "/blob/main/METHODOLOGY.md");
    else meth.removeAttribute("href");
    var ru = runUrl(DAY);
    $("runLinkWrap").innerHTML = ru
      ? '<a class="ilink" href="' + esc(ru) + '" target="_blank" rel="noopener">Today’s run folder</a>'
      : '<span class="mono">runs/' + esc(runDate(DAY) || "YYYY-MM-DD") + "/</span>";
    $("footStamp").textContent = (SAMPLE ? "Sample data · " : "") + "Last run " + (D.date || "n/a") + (SLOT != null ? " · " + SLOT_LABEL.toLowerCase() + " " + SLOT : "");
  });

  // ---------- hero ----------
  safe("hero", function () {
    var eb = $("heroEyebrow");
    eb.textContent = (SAMPLE ? "SAMPLE · " : "") + "Day " + DAY + " · " + (D.category || "") + " · " + (D.date || "");
    if (SAMPLE) eb.classList.add("is-sample");
    var n = results.length;
    $("heroTitle").innerHTML = n === 0
      ? "Same tools. Same task."
      : failCount === 0
        ? "Same tools. Same task.<br>All " + n + " models passed today."
        : "Same tools. Same task.<br><em>" + failCount + " of " + n + " models</em> got it wrong today.";
    $("heroMeta").innerHTML =
      "<div><dt>Ground truth</dt><dd>" + esc(gtText()) + "</dd></div>" +
      "<div><dt>Source</dt><dd>" + esc(String(D.today.source || "n/a").split(",")[0]) + "</dd></div>" +
      "<div><dt>" + SLOT_LABEL + "</dt><dd>" + esc(SLOT != null ? "#" + SLOT : "n/a") + "</dd></div>";
  });

  // orthogonal PCB trace: horizontal, 45deg chamfer, vertical, chamfer, horizontal
  function ortho(x0, y0, xv, y1, x2, c) {
    c = c == null ? 6 : c;
    var dy = y1 - y0;
    if (Math.abs(dy) < 2 * c + 0.5) return "M" + f2(x0) + " " + f2(y0) + " H" + f2(xv) + " V" + f2(y1) + " H" + f2(x2);
    var sg = dy > 0 ? 1 : -1, sx1 = xv > x0 ? 1 : -1, sx2 = x2 > xv ? 1 : -1;
    return "M" + f2(x0) + " " + f2(y0) +
      " H" + f2(xv - sx1 * c) + " L" + f2(xv) + " " + f2(y0 + sg * c) +
      " V" + f2(y1 - sg * c) + " L" + f2(xv + sx2 * c) + " " + f2(y1) +
      " H" + f2(x2);
  }
  // lane order that keeps fan-in traces from crossing
  function lanes(sy, ey, finalLeft) {
    var downs = [], ups = [], out = [];
    sy.forEach(function (y, i) { (ey[i] >= y ? downs : ups).push(i); });
    downs.forEach(function (i, k) { out[i] = downs.length - 1 - k; });
    ups.forEach(function (i, k) { out[i] = k; });
    if (finalLeft) { var mx = Math.max.apply(null, out.concat([0])); out = out.map(function (l) { return mx - l; }); }
    return out;
  }
  function packets(parent, d, cls, dur, count, delay) {
    if (RM) {
      // reduced motion: one static dot sitting on the trace
      var m = /M([\d.]+) ([\d.]+) H([\d.]+)/.exec(d);
      if (m) svg("circle", { cx: (+m[1] + +m[3]) / 2, cy: m[2], r: 2.6, class: cls }, parent);
      return;
    }
    for (var k = 0; k < count; k++) {
      var c = svg("circle", { r: 2.8, class: cls }, parent);
      svg("animateMotion", { dur: dur + "s", repeatCount: "indefinite", path: d, begin: "-" + (k * dur / count + delay).toFixed(2) + "s" }, c);
    }
  }

  // ---------- hero rack ----------
  function drawRack() {
    var s = $("rack");
    if (!s) return;
    clear(s);
    var compact = !!mqSM.matches;
    var N = Math.max(results.length, 1);
    var W = compact ? 380 : 600, H = compact ? 716 : 500;
    s.setAttribute("viewBox", "0 0 " + W + " " + H);
    s.setAttribute("class", compact ? "rack-compact" : "");
    var x0 = compact ? 10 : 18, x1 = compact ? 330 : 350, yT = compact ? 52 : 50, yB = compact ? 456 : 478;
    var DX = 18, DY = -10;
    var cx = compact ? 182 : 494, by = compact ? 588 : 268, a = 58, bh = 46, sz = 21;

    // verifier glow (behind everything)
    svg("circle", { cx: cx, cy: by, r: compact ? 120 : 130, fill: "url(#arcGlow)" }, s);

    // rack body: top + side faces give the 3/4 view
    svg("polygon", { points: [x0, yT, x0 + DX, yT + DY, x1 + DX, yT + DY, x1, yT].join(" "), class: "rack-top" }, s);
    svg("polygon", { points: [x1, yT, x1 + DX, yT + DY, x1 + DX, yB + DY, x1, yB].join(" "), class: "rack-side" }, s);
    svg("rect", { x: x0, y: yT, width: x1 - x0, height: yB - yT, rx: 4, class: "rack-front" }, s);
    svg("rect", { x: x0 + 6, y: yT + 6, width: 14, height: yB - yT - 12, rx: 2, class: "rack-rail" }, s);
    svg("rect", { x: x1 - 20, y: yT + 6, width: 14, height: yB - yT - 12, rx: 2, class: "rack-rail" }, s);
    for (var hy = yT + 14; hy < yB - 10; hy += 12) {
      svg("rect", { x: x0 + 11, y: hy, width: 4, height: 4, class: "rack-hole" }, s);
      svg("rect", { x: x1 - 15, y: hy, width: 4, height: 4, class: "rack-hole" }, s);
    }
    text(s, { x: x0 + 28, y: yT + 18, class: "rack-cap" }, "ARC-01 · " + results.length + "× GPU NODE · DAY " + DAY);

    // sleds
    var inner0 = yT + 28, inner1 = yB - 10, gap = compact ? 8 : 10;
    var sledH = Math.min(68, (inner1 - inner0 - gap * (N - 1)) / N);
    var sx = x0 + 28, sw = (x1 - 22) - sx;
    var sledCy = [];
    results.forEach(function (r, i) {
      var m = M[r.model];
      var y = inner0 + i * (sledH + gap), cy = y + sledH / 2;
      sledCy.push(cy);
      var g = svg("g", {}, s);
      g.style.setProperty("--c", m.color);
      [y + 10, y + sledH - 10].forEach(function (sy) {
        svg("circle", { cx: x0 + 13, cy: sy, r: 2.6, class: "rack-screw" }, g);
        svg("circle", { cx: x1 - 13, cy: sy, r: 2.6, class: "rack-screw" }, g);
      });
      svg("rect", { x: sx, y: y, width: sw, height: sledH, rx: 5, class: "sled" }, g);
      svg("rect", { x: sx + 4, y: y + 8, width: 3, height: sledH - 16, rx: 1.5, fill: m.color }, g);
      text(g, { x: sx + 14, y: y + (compact ? 20 : 19), class: "sled-name" }, m.name);
      text(g, { x: sx + 14, y: y + (compact ? 37 : 35), class: "sled-stat " + (r.pass ? "is-pass" : "is-fail") },
        r.delta == null ? "NO ANSWER" : (r.pass ? "PASS " : "FAIL ") + fmtDelta(r.delta));
      // step-budget bar (real data: steps used / max steps)
      var by0 = y + sledH - (compact ? 13 : 14), bw = 62;
      svg("rect", { x: sx + 14, y: by0, width: bw, height: 5, rx: 1, class: "util-bg" }, g);
      svg("rect", { x: sx + 14, y: by0, width: Math.max(1, bw * Math.min(r.steps / MAXSTEPS, 1)), height: 5, rx: 1, fill: m.color, opacity: 0.85 }, g);
      text(g, { x: sx + 14 + bw + 5, y: by0 + 5, class: "sled-mini" }, r.steps + "/" + MAXSTEPS);
      // 4 SXM-style modules
      for (var k = 0; k < 4; k++) {
        var mx = sx + 112 + k * 26;
        svg("rect", { x: mx, y: y + 8, width: 22, height: sledH - 16, rx: 2, fill: "url(#arcSpreader)", class: "sxm" }, g);
        svg("rect", { x: mx + 5, y: y + 16, width: 12, height: sledH - 32, rx: 1, class: "sxm-die" }, g);
        svg("rect", { x: mx, y: y + 8, width: 22, height: 2, fill: m.color, opacity: 0.9 }, g);
      }
      // 2x4 drive bays with activity LEDs
      var rh = (sledH - 16 - 6) / 4;
      for (var c = 0; c < 2; c++) for (var rw = 0; rw < 4; rw++) {
        var bx = sx + 218 + c * 18, byy = y + 8 + rw * (rh + 2);
        svg("rect", { x: bx, y: byy, width: 16, height: rh, rx: 1.5, class: "bay" }, g);
        var led = svg("circle", { cx: bx + 12.5, cy: byy + rh / 2, r: 1.2, class: "bay-led" }, g);
        led.style.animationDelay = (((i * 7 + rw * 3 + c * 5) % 9) * 0.23).toFixed(2) + "s";
        led.style.animationDuration = (1.1 + ((i + rw + c) % 4) * 0.35).toFixed(2) + "s";
      }
      // status LED column
      svg("circle", { cx: sx + sw - 9, cy: y + 13, r: 2.8, class: "led " + (r.pass ? "ok" : "bad") }, g);
      svg("circle", { cx: sx + sw - 9, cy: y + 24, r: 2.2, class: "led-dim" }, g);
      svg("circle", { cx: sx + sw - 9, cy: y + 34, r: 2.2, class: "led-dim" }, g);
    });

    // cable tray on top + a bundle of model-coloured cables down the back edge
    var tx0 = x0 + 34, tx1 = x1 - 14, ty = yT - 8;
    svg("polygon", { points: [tx0, ty, tx0 + DX * 0.7, ty + DY * 0.7, tx1 + DX * 0.7, ty + DY * 0.7, tx1, ty].join(" "), class: "tray-top" }, s);
    results.forEach(function (r, i) {
      var f = (3 + i * 2.6) / DX, xs = x1 + f * DX, yTop = yT + f * DY;
      var d = "M" + (tx0 + 20 + i * 5) + " " + (ty - 2 + i * 0.6 * 0) + " L" + (xs - 3) + " " + (ty - 2) + " L" + xs + " " + (yTop + 2) + " V" + (sledCy[i] + f * DY);
      svg("path", { d: d, class: "cable", stroke: M[r.model].color }, s);
      svg("circle", { cx: xs, cy: sledCy[i] + f * DY, r: 1.8, fill: M[r.model].color }, s);
    });
    svg("rect", { x: tx0, y: ty, width: tx1 - tx0, height: 6, rx: 1, class: "tray-lip" }, s);

    // traces from each node to the verifier
    var entries = [];
    var finalLeft = compact;
    results.forEach(function (r, i) {
      var j = compact ? (N - 1 - i) : i;
      entries.push(by + 9 + j * ((bh - 18) / Math.max(N - 1, 1)));
    });
    var starts = sledCy.map(function (y) { return y + DY * 0.5; });
    var laneIdx = lanes(starts, entries, finalLeft);
    var bus = svg("g", {}, s);
    results.forEach(function (r, i) {
      var xs0 = x1 + DX + 3;
      var xv = compact ? x1 + DX + 10 + laneIdx[i] * 6 : x1 + DX + 18 + laneIdx[i] * 9;
      var ex = compact ? cx + a + 3 : cx - a - 3;
      var d = ortho(xs0, starts[i], xv, entries[i], ex, compact ? 4 : 6);
      svg("path", { d: d, class: "bus" }, bus);
      svg("circle", { cx: xs0, cy: starts[i], r: 3, class: "via" }, bus);
      svg("circle", { cx: ex, cy: entries[i], r: 3, class: "via" }, bus);
      packets(bus, d, r.pass ? "packet-pass" : "packet-fail", 2.4 + i * 0.3, 2, i * 0.2);
    });

    // verifier appliance: isometric box with vent grille, ground-truth blocks on top
    var g2 = svg("g", {}, s);
    svg("polygon", { points: [cx - a, by, cx, by + a / 2, cx, by + a / 2 + bh, cx - a, by + bh].join(" "), class: "ver-left" }, g2);
    svg("polygon", { points: [cx, by + a / 2, cx + a, by, cx + a, by + bh, cx, by + a / 2 + bh].join(" "), class: "ver-right" }, g2);
    svg("polygon", { points: [cx, by - a / 2, cx + a, by, cx, by + a / 2, cx - a, by].join(" "), class: "ver-top" }, g2);
    for (var v = 0; v < 5; v++) {
      var vy = by + 12 + v * 6;
      svg("line", { x1: cx - a + 8, y1: vy, x2: cx - 10, y2: vy + (a - 18) * 0.5, class: "ver-vent" }, g2);
    }
    svg("polygon", { points: [cx + 10, by + a / 2 + 2, cx + a - 10, by + 7, cx + a - 10, by + 19, cx + 10, by + a / 2 + 14].join(" "), class: "ver-panel" }, g2);
    svg("circle", { cx: cx + a - 16, cy: by + bh - 4, r: 2.6, class: "led ok" }, g2);
    var cy0 = by + 4 - 1.5 * sz;
    [0, 1, 2].forEach(function (j) { cube(g2, cx, cy0 - j * sz, sz, j === 2); });
    var topY = cy0 - 2 * sz - sz / 2;
    text(s, { x: cx, y: topY - 34, "text-anchor": "middle", class: "chain-label" }, "GROUND TRUTH");
    text(s, { x: cx, y: topY - 14, "text-anchor": "middle", class: "chain-big" }, gtText());
    var botY = by + a / 2 + bh;
    text(s, { x: cx, y: botY + 26, "text-anchor": "middle", class: "chain-label" }, "VERIFIER · SNAPSHOT " + SLOT_LABEL.toUpperCase());
    text(s, { x: cx, y: botY + 46, "text-anchor": "middle", class: "chain-big" }, SLOT != null ? "#" + SLOT : "n/a");

    if (SAMPLE) text(s, { x: W - 6, y: compact ? 16 : 18, "text-anchor": "end", class: "wm" }, "SAMPLE DATA");
    applyZone($("heroVisual"));
  }

  function cube(p, cx, cy, sz, top) {
    var g = svg("g", {}, p);
    svg("polygon", { points: [cx - sz, cy, cx, cy + sz / 2, cx, cy + sz * 1.5, cx - sz, cy + sz].join(" "), class: "block-left" }, g);
    svg("polygon", { points: [cx, cy + sz / 2, cx + sz, cy, cx + sz, cy + sz, cx, cy + sz * 1.5].join(" "), class: "block-right" }, g);
    var t = svg("polygon", { points: [cx, cy - sz / 2, cx + sz, cy, cx, cy + sz / 2, cx - sz, cy].join(" "), class: "block-top" }, g);
    if (top) {
      t.style.stroke = "var(--pass)";
      svg("path", { d: "M" + (cx - 7) + " " + cy + " l5 4.5 l10 -9", class: "block-check" }, g);
    }
  }

  // ---------- off-screen pausing (CSS + SMIL) ----------
  var zoneState = {};
  function applyZone(el) {
    if (!el) return;
    var off = zoneState[el.id] === true;
    el.classList.toggle("paused", off);
    var svgs = el.tagName.toLowerCase() === "svg" ? [el] : Array.prototype.slice.call(el.querySelectorAll("svg"));
    svgs.forEach(function (sv) {
      if (sv.ownerSVGElement) return; // only root svgs carry the SMIL clock
      try { if (off || RM) { if (sv.pauseAnimations) sv.pauseAnimations(); } else if (sv.unpauseAnimations) sv.unpauseAnimations(); } catch (e) { /* ignore */ }
    });
  }
  function watchZones() {
    var zones = Array.prototype.slice.call(document.querySelectorAll(".anim-zone"));
    if (!("IntersectionObserver" in window)) return;
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        zoneState[en.target.id] = !en.isIntersecting;
        applyZone(en.target);
      });
    }, { rootMargin: "80px" });
    zones.forEach(function (z) { io.observe(z); });
  }

  safe("rack", function () {
    drawRack();
    on(mqSM, function () { safe("rack", drawRack); });
  });

  // ---------- stats: server front LCD ----------
  safe("stats", function () {
    var N = Math.max(models.length, 1);
    var defs = [
      { k: "Day", v: DAY, dec: 0, small: " / " + TOTAL, frac: DAY / TOTAL },
      { k: "Runs logged", v: runsTotal, dec: 0, frac: runsTotal / (TOTAL * N) },
      { k: "Runs with stored evidence", v: storedPct, dec: 0, small: "%", frac: storedPct / 100 },
      { k: "Compute spent", v: computeUsd, dec: 2, pre: "$", frac: computeUsd / Math.max(computeUsd / Math.max(DAY, 1) * TOTAL, 0.01) }
    ];
    function fmt(d, v) { return (d.pre || "") + (d.dec ? v.toFixed(d.dec) : Math.round(v).toLocaleString("en-US")); }
    $("stats").innerHTML = defs.map(function (d, i) {
      var lit = Math.round(Math.max(0, Math.min(1, d.frac)) * 12);
      var rail = "";
      for (var k = 0; k < 12; k++) rail += "<i" + (k < lit ? ' class="on"' : "") + "></i>";
      return '<div class="stat"><div class="led-rail" aria-hidden="true">' + rail + '</div><div class="k">' + esc(d.k) + (SAMPLE ? ' <span class="tag-sample">SAMPLE</span>' : "") + '</div>' +
        '<div class="v"><span class="sr-only">' + esc(fmt(d, d.v) + (d.small || "")) + '</span><span aria-hidden="true"><span class="cnt" data-i="' + i + '">' + esc(fmt(d, d.v)) + "</span>" +
        (d.small ? "<small>" + esc(d.small) + "</small>" : "") + "</span></div></div>";
    }).join("");
    if (RM || !("IntersectionObserver" in window) || !window.requestAnimationFrame) return;
    var cnts = $("stats").querySelectorAll(".cnt");
    var io = new IntersectionObserver(function (en) {
      if (!en[0].isIntersecting) return;
      io.disconnect();
      var t0 = null;
      function frame(t) {
        if (t0 == null) t0 = t;
        var p = Math.min((t - t0) / 1100, 1), e = 1 - Math.pow(1 - p, 3);
        Array.prototype.forEach.call(cnts, function (el) { var d = defs[+el.getAttribute("data-i")]; el.textContent = fmt(d, d.v * e); });
        if (p < 1) requestAnimationFrame(frame);
      }
      requestAnimationFrame(frame);
    }, { threshold: 0.4 });
    io.observe($("stats"));
  });

  // ---------- today ----------
  safe("task", function () {
    $("taskCard").innerHTML =
      '<div class="label">Task · ' + esc(D.category || "") + "</div>" +
      "<h3>" + esc(D.today.title || "Today's task") + "</h3>" +
      '<p class="prompt">' + esc(D.today.prompt || "") + "</p>" +
      '<div class="truth"><div class="label">Ground truth</div><div class="v">' + esc(gtText()) + "</div></div>" +
      '<div class="kv"><span>Source</span><span>' + esc(D.today.source || "n/a") + "</span></div>" +
      '<div class="kv"><span>' + SLOT_LABEL + "</span><span>" + esc(SLOT != null ? "#" + SLOT : "n/a") + "</span></div>" +
      '<div class="kv"><span>Pass if</span><span>' + THR + "% below best (" + Math.round(THR * 100) + " bps); above best fails</span></div>" +
      '<div class="tools">' + (D.today.tools || []).map(function (t) { return '<span class="tool">' + esc(t) + "</span>"; }).join("") + "</div>" +
      (D.today.verify ? '<p class="verify">' + esc(D.today.verify) + "</p>" : "");
  });

  var traceFocusAfterSelect = false;
  safe("results", function () {
    var tbody = $("resultsTable").querySelector("tbody");
    tbody.innerHTML = results.map(function (r) {
      var m = M[r.model];
      var w = r.delta == null ? 100 : Math.max(4, Math.min(Math.abs(r.delta) / 8, 1) * 100);
      return '<tr data-model="' + esc(r.model) + '">' +
        '<td><div class="mname"><span class="dot" style="background:' + m.color + '"></span><div>' + esc(m.name) + '<span class="mvendor">' + esc(m.vendor || "") + "</span></div></div></td>" +
        '<td class="num">' + (r.answer == null ? "no answer" : r.answer.toFixed(4)) + "</td>" +
        '<td><div class="delta" title="' + esc(fmtBps(r.delta)) + '"><div class="delta-bar meter"><span style="width:' + w + "%;background:" + (r.pass ? "var(--pass)" : "var(--fail)") + '"></span></div>' + fmtDelta(r.delta) + "</div></td>" +
        '<td><span class="pill ' + (r.pass ? "pass" : "fail") + '">' + (r.pass ? "Pass" : "Fail") + "</span></td>" +
        '<td class="num hide-sm">' + usd(r.cost) + "</td>" +
        '<td class="num hide-sm">' + r.steps + "</td>" +
        '<td class="go"><button type="button" class="go-btn" data-model="' + esc(r.model) + '" aria-label="Open trace for ' + esc(m.name) + '"><span class="go-label">Trace </span>→</button></td></tr>';
    }).join("");
    tbody.addEventListener("click", function (e) {
      var tr = e.target.closest("tr");
      if (!tr) return;
      selectTrace(tr.getAttribute("data-model"));
      $("trace").scrollIntoView({ behavior: RM ? "auto" : "smooth" });
      var tab = document.querySelector('.trace-tab[aria-selected="true"]');
      if (tab) tab.focus({ preventScroll: true });
    });
    if (fotd) {
      $("fotd").hidden = false;
      $("fotd").innerHTML = '<span class="tag">Fail of the day</span><p><b>' + esc(M[fotd.model].name) + ".</b> " + esc(fotd.text || "") + "</p>";
    }
  });

  // ---------- traces ----------
  var ICON = {
    think: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2"><rect x="2.5" y="2.5" width="5" height="5" rx=".6"/><path d="M4 .5v2M6 .5v2M4 7.5v2M6 7.5v2M.5 4h2M.5 6h2M7.5 4h2M7.5 6h2"/></svg>',
    tool: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M3.5.8v2.4M6.5.8v2.4M2.2 3.2h5.6v1.6a2.8 2.8 0 0 1-5.6 0zM5 7.6v1.8"/></svg>',
    result: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 1.5v3.2a1.6 1.6 0 0 1-1.6 1.6H1.8M4 4.1 1.8 6.3 4 8.5"/></svg>',
    error: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" stroke-linecap="round"><path d="M5 1 9.3 8.8H.7z"/><path d="M5 4v2.2M5 7.5v.1"/></svg>',
    answer: '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m1.6 5.3 2.3 2.3 4.5-5"/></svg>',
    other: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="1.8" fill="currentColor"/></svg>'
  };
  var tabOrder = results.map(function (r) { return r.model; });

  safe("traceTabs", function () {
    var tabs = $("traceTabs");
    tabs.innerHTML = results.map(function (r) {
      var m = M[r.model];
      return '<button type="button" class="trace-tab" role="tab" id="tab-' + esc(r.model) + '" aria-controls="tracePanel" aria-selected="false" tabindex="-1" data-model="' + esc(r.model) + '" style="--tab-color:' + m.color + '"><span class="dot" style="background:' + m.color + '" aria-hidden="true"></span>' + esc(m.name) + "</button>";
    }).join("");
    tabs.addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (b) selectTrace(b.getAttribute("data-model"));
    });
    tabs.addEventListener("keydown", function (e) {
      var cur = document.activeElement && document.activeElement.getAttribute("data-model");
      var i = tabOrder.indexOf(cur), n = tabOrder.length, j = -1;
      if (i < 0 || !n) return;
      if (e.key === "ArrowRight") j = (i + 1) % n;
      else if (e.key === "ArrowLeft") j = (i - 1 + n) % n;
      else if (e.key === "Home") j = 0;
      else if (e.key === "End") j = n - 1;
      if (j < 0) return;
      e.preventDefault();
      selectTrace(tabOrder[j]);
      $("tab-" + tabOrder[j]).focus();
    });
  });

  function telemetry(r) {
    var s = svg("svg", { viewBox: "0 0 252 168", class: "telemetry", role: "img", "aria-label": "Latency " + r.latency.toFixed(1) + " seconds, " + r.steps + " of " + MAXSTEPS + " steps, cost " + usd(r.cost) });
    // oscilloscope: latency as pulse width (scaled to the slowest model today)
    var maxLat = Math.max.apply(null, results.map(function (x) { return x.latency; }).concat([0.1]));
    svg("rect", { x: 0.5, y: 0.5, width: 251, height: 66, rx: 8, class: "tm-bg" }, s);
    for (var gx = 21; gx < 252; gx += 21) svg("line", { x1: gx, y1: 4, x2: gx, y2: 63, class: "tm-grid" }, s);
    for (var gy = 17; gy < 66; gy += 16) svg("line", { x1: 4, y1: gy, x2: 248, y2: gy, class: "tm-grid" }, s);
    var w = 20 + 180 * (r.latency / maxLat);
    var x0 = 14, base = 52, hi = 22;
    var pts = [[4, base], [x0, base], [x0 + 3, hi], [x0 + 6, hi + 3], [x0 + w - 3, hi + 1], [x0 + w, base], [x0 + w + 4, base + 3], [x0 + w + 8, base], [248, base]];
    var wave = svg("polyline", { points: pts.map(function (p) { return p[0].toFixed(1) + "," + p[1]; }).join(" "), class: "tm-wave" + (r.pass ? "" : " fail") }, s);
    void wave;
    text(s, { x: 10, y: 14, class: "tm-label" }, "LATENCY");
    text(s, { x: 242, y: 14, "text-anchor": "end", class: "tm-value" }, r.latency.toFixed(1) + " s");
    // segmented LED bar: steps used of the step budget
    text(s, { x: 2, y: 84, class: "tm-label" }, "STEPS");
    text(s, { x: 250, y: 84, "text-anchor": "end", class: "tm-value" }, r.steps + " / " + MAXSTEPS);
    var segW = (248 - 2 * (MAXSTEPS - 1)) / MAXSTEPS;
    for (var k = 0; k < MAXSTEPS; k++) {
      svg("rect", { x: 2 + k * (segW + 2), y: 90, width: segW, height: 10, rx: 1.5, class: "tm-seg" + (k < r.steps ? (r.steps > MAXSTEPS ? " over" : " on") : "") }, s);
    }
    // power-draw style gauge: cost vs. the most expensive run today
    var maxCost = Math.max.apply(null, results.map(function (x) { return x.cost; }).concat([0.0001]));
    var f = Math.max(0, Math.min(1, r.cost / maxCost));
    var gcx = 36, gcy = 160, gr = 28;
    function pt(t) { var ang = Math.PI * (1 - t); return [gcx + gr * Math.cos(ang), gcy - gr * Math.sin(ang)]; }
    var p0 = pt(0), p1 = pt(1), pf = pt(f);
    svg("path", { d: "M" + p0[0] + " " + p0[1] + " A" + gr + " " + gr + " 0 0 1 " + p1[0].toFixed(2) + " " + p1[1].toFixed(2), class: "tm-arc-bg" }, s);
    if (f > 0.001) svg("path", { d: "M" + p0[0] + " " + p0[1] + " A" + gr + " " + gr + " 0 0 1 " + pf[0].toFixed(2) + " " + pf[1].toFixed(2), class: "tm-arc" }, s);
    var nd = pt(f);
    svg("line", { x1: gcx, y1: gcy, x2: (gcx + (nd[0] - gcx) * 0.8).toFixed(2), y2: (gcy + (nd[1] - gcy) * 0.8).toFixed(2), class: "tm-needle" }, s);
    svg("circle", { cx: gcx, cy: gcy, r: 2.5, fill: "var(--text)" }, s);
    text(s, { x: 78, y: 132, class: "tm-label" }, "COST THIS RUN");
    text(s, { x: 78, y: 148, class: "tm-value" }, usd(r.cost));
    text(s, { x: 78, y: 162, class: "tm-label" }, "scale: max cost today");
    return s;
  }

  function selectTrace(id) {
    if (!known(id) || !R[id]) return;
    var m = M[id], r = R[id], steps = traces[id] || [];
    Array.prototype.forEach.call(document.querySelectorAll(".trace-tab"), function (b) {
      var sel = b.getAttribute("data-model") === id;
      b.setAttribute("aria-selected", sel ? "true" : "false");
      b.setAttribute("tabindex", sel ? "0" : "-1");
    });
    $("tracePanel").setAttribute("aria-labelledby", "tab-" + id);
    $("traceList").innerHTML = steps.length ? steps.map(function (s, i) {
      var t = ICON.hasOwnProperty(s && s.t) && s.t !== "other" ? s.t : "other";
      return '<li class="s-' + t + '" style="animation-delay:' + i * 70 + 'ms"><span class="step-icon" aria-hidden="true">' + ICON[t] + '</span><span class="step-type">' + esc((s && s.t) || "step") + '</span><p class="step-text">' + esc(s && s.x) + "</p></li>";
    }).join("") : '<li class="s-other"><span class="step-icon" aria-hidden="true">' + ICON.other + '</span><span class="step-type">no trace</span><p class="step-text">No trace was stored for this run.</p></li>';
    var verdict = r.pass
      ? "At most " + THR + "% below the best route. Pass."
      : (fotd && fotd.model === id ? fotd.text : (r.answer == null ? "Never produced a valid answer." : (r.delta != null && r.delta > 0 ? "Above the best reachable output (hallucinated route)." : "More than " + THR + "% below the best route.")));
    var side = $("traceSide");
    side.innerHTML =
      '<div class="kicker">' + esc(m.name) + " · final answer" + (SAMPLE ? ' <span class="tag-sample">SAMPLE</span>' : "") + "</div>" +
      '<div class="big" style="color:' + (r.pass ? "var(--pass)" : "var(--fail)") + '">' + (r.answer == null ? "none" : r.answer.toFixed(4)) + "</div>" +
      '<div class="mono muted" style="font-size:13px;margin-bottom:10px">best ' + esc(gtText()) + "</div>" +
      '<div id="tmSlot"></div>' +
      '<div class="kv"><span>vs. best</span><span>' + fmtDelta(r.delta) + " · " + fmtBps(r.delta) + "</span></div>" +
      '<div class="kv"><span>Steps</span><span>' + r.steps + " of " + MAXSTEPS + "</span></div>" +
      '<div class="kv"><span>Latency</span><span>' + r.latency.toFixed(1) + "s</span></div>" +
      '<div class="kv"><span>Cost</span><span>' + usd(r.cost) + "</span></div>" +
      '<p class="verdict">' + esc(verdict) + "</p>";
    $("tmSlot").appendChild(telemetry(r));
  }
  safe("traceInit", function () {
    var first = fotd && R[fotd.model] ? fotd.model : (results[0] && results[0].model);
    if (first) selectTrace(first);
  });

  // ---------- chart ----------
  safe("chart", function () {
    var n = N_HIST;
    var chart = $("chart"), wrap = $("chartWrap");
    $("boardSub").textContent = "Cumulative pass rate: passes ÷ attempts since day " + Math.max(FIRST_DAY, 1) + ". One task per day, so each model has n = " + n + " attempt" + (n === 1 ? "" : "s") + " so far.";
    if (n === 0) {
      wrap.hidden = true; $("chartEmpty").hidden = false; return;
    }
    var W = 760, H = 320;
    var all = [];
    models.forEach(function (m) { S[m.id].rates.forEach(function (v) { if (v != null) all.push(v); }); });
    var mn = all.length ? Math.min.apply(null, all) : 0;
    var YMIN = Math.max(0, Math.min(40, Math.floor(mn / 10) * 10 - 10)), YMAX = 100;
    var span = Math.max(n - 1, 1);
    function px(i) { return n === 1 ? W / 2 : (i / span) * W; }
    function py(v) { return 300 - ((v - YMIN) / (YMAX - YMIN)) * 290; }
    var step = (YMAX - YMIN) > 60 ? 20 : 10;
    for (var gv = YMIN; gv <= YMAX; gv += step) {
      svg("line", { x1: 0, x2: W, y1: py(gv), y2: py(gv), class: "grid-line" }, chart);
      var lab = document.createElement("div");
      lab.className = "axis";
      lab.style.left = "0";
      lab.style.top = "calc(" + (py(gv) / H) * 100 + "% - 16px)";
      lab.textContent = gv + "%";
      wrap.appendChild(lab);
    }
    var ticks = n === 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1].filter(function (v, i, a) { return a.indexOf(v) === i; });
    ticks.forEach(function (i) {
      var lab = document.createElement("div");
      lab.className = "axis";
      lab.style.bottom = "-22px";
      lab.style.left = (px(i) / W) * 100 + "%";
      lab.style.transform = n === 1 ? "translateX(-50%)" : i === 0 ? "none" : i === n - 1 ? "translateX(-100%)" : "translateX(-50%)";
      lab.textContent = "Day " + (FIRST_DAY + i);
      wrap.appendChild(lab);
    });
    if (SAMPLE) {
      var wm = document.createElement("div");
      wm.className = "wm-html"; wm.textContent = "SAMPLE DATA"; wm.setAttribute("aria-hidden", "true");
      wrap.appendChild(wm);
    }
    var cursor = svg("line", { y1: 0, y2: H, class: "cursor", visibility: "hidden" }, chart);
    var lines = {}, dots = {}, single = {};
    models.forEach(function (m) {
      var pts = [];
      for (var i = 0; i < n; i++) { var v = rateAt(m.id, i); if (v != null) pts.push(px(i).toFixed(1) + "," + py(v).toFixed(1)); }
      lines[m.id] = svg("polyline", { points: pts.join(" "), class: "series", stroke: m.color }, chart);
      if (pts.length === 1) {
        var xy = pts[0].split(",");
        single[m.id] = svg("circle", { cx: xy[0], cy: xy[1], r: 4, fill: m.color, class: "series-dot" }, chart);
      }
      var dot = document.createElement("div");
      dot.className = "chart-dot";
      dot.style.background = m.color;
      wrap.appendChild(dot);
      dots[m.id] = dot;
    });
    var hidden = {};
    $("legend").innerHTML = models.map(function (m) {
      return '<button type="button" aria-pressed="true" data-model="' + esc(m.id) + '"><span class="dot" style="background:' + m.color + '" aria-hidden="true"></span>' + esc(m.name) + "</button>";
    }).join("");
    $("legend").addEventListener("click", function (e) {
      var b = e.target.closest("button");
      if (!b) return;
      var id = b.getAttribute("data-model");
      hidden[id] = !hidden[id];
      b.setAttribute("aria-pressed", String(!hidden[id]));
      lines[id].classList.toggle("off", !!hidden[id]);
      if (single[id]) single[id].classList.toggle("off", !!hidden[id]);
      if (cur >= 0) show(cur, true);
    });
    var tip = $("tip"), live = $("chartLive"), cur = -1;
    function show(i, force) {
      var rect = wrap.getBoundingClientRect();
      var x = px(i);
      cursor.setAttribute("x1", x); cursor.setAttribute("x2", x);
      cursor.setAttribute("visibility", "visible");
      models.forEach(function (m) {
        var d = dots[m.id], v = rateAt(m.id, i);
        if (hidden[m.id] || v == null) { d.style.display = "none"; return; }
        d.style.display = "block";
        d.style.left = (x / W) * 100 + "%";
        d.style.top = (py(v) / H) * 100 + "%";
      });
      if (i !== cur || force) {
        var rows = models.filter(function (m) { return !hidden[m.id] && rateAt(m.id, i) != null; }).map(function (m) {
          var s = S[m.id], k = i - (N_HIST - s.rates.length), detail = "";
          if (s.hasLog && k >= 0) {
            var p = 0, a = 0;
            for (var j = 0; j <= k; j++) if (s.outcomes[j] != null) { a++; p += s.outcomes[j]; }
            detail = " (" + p + "/" + a + ")";
          }
          return { m: m, v: rateAt(m.id, i), detail: detail };
        }).sort(function (a, b) { return b.v - a.v; });
        tip.innerHTML = '<div style="color:var(--text);margin-bottom:6px">Day ' + (FIRST_DAY + i) + "</div>" + rows.map(function (o) {
          return '<div class="row"><span><span class="dot" style="background:' + o.m.color + '"></span>' + esc(o.m.name) + "</span><span>" + pct(o.v) + esc(o.detail) + "</span></div>";
        }).join("");
        live.textContent = "Day " + (FIRST_DAY + i) + ": " + rows.map(function (o) { return o.m.name + " " + pct(o.v) + o.detail; }).join(", ");
        cur = i;
      }
      tip.hidden = false;
      var left = (x / W) * rect.width + 14;
      if (left > rect.width - tip.offsetWidth - 4) left = (x / W) * rect.width - tip.offsetWidth - 14;
      left = Math.max(0, Math.min(left, rect.width - tip.offsetWidth));
      tip.style.left = left + "px";
    }
    function hide() {
      tip.hidden = true;
      cursor.setAttribute("visibility", "hidden");
      Object.keys(dots).forEach(function (k) { dots[k].style.display = "none"; });
    }
    function fromEvent(e) {
      var rect = wrap.getBoundingClientRect();
      var frac = Math.min(Math.max((e.clientX - rect.left) / rect.width, 0), 1);
      return n === 1 ? 0 : Math.round(frac * (n - 1));
    }
    wrap.addEventListener("pointermove", function (e) { show(fromEvent(e)); });
    wrap.addEventListener("pointerdown", function (e) { show(fromEvent(e)); });
    wrap.addEventListener("pointerleave", function (e) { if (e.pointerType === "mouse") hide(); });
    wrap.addEventListener("keydown", function (e) {
      var i = cur < 0 ? n - 1 : cur;
      if (e.key === "ArrowRight") i = Math.min(n - 1, i + 1);
      else if (e.key === "ArrowLeft") i = Math.max(0, i - 1);
      else if (e.key === "Home") i = 0;
      else if (e.key === "End") i = n - 1;
      else if (e.key === "Escape") { hide(); return; }
      else return;
      e.preventDefault();
      show(i);
    });
    wrap.addEventListener("focus", function () { show(cur < 0 ? n - 1 : cur); });
    wrap.addEventListener("blur", hide);
  });

  // ---------- board ----------
  var meters = [];
  safe("board", function () {
    if (N_HIST === 0) {
      $("board").innerHTML = '<li class="muted">No history yet.</li>';
      return;
    }
    var ranked = models.slice().sort(function (a, b) {
      var va = latestRate(a.id), vb = latestRate(b.id);
      return (vb == null ? -1 : vb) - (va == null ? -1 : va) || a.name.localeCompare(b.name);
    });
    $("board").innerHTML = ranked.map(function (m, i) {
      var s = S[m.id], acc = latestRate(m.id);
      var prev = N_HIST > 7 ? rateAt(m.id, N_HIST - 8) : null;
      var wk = acc != null && prev != null ? Math.round((acc - prev) * 10) / 10 : null;
      var arrow = wk == null || wk === 0
        ? '<span class="muted" aria-hidden="true">—</span><span class="sr-only">no change over 7 days</span>'
        : wk > 0
          ? '<span class="up"><span aria-hidden="true">▲</span>' + wk.toFixed(1) + 'pp</span><span class="sr-only"> up over 7 days</span>'
          : '<span class="down"><span aria-hidden="true">▼</span>' + Math.abs(wk).toFixed(1) + 'pp</span><span class="sr-only"> down over 7 days</span>';
      var nTxt = s.hasLog ? s.passes + "/" + s.attempts + " · n=" + s.attempts : "n=" + s.rates.length;
      return '<li style="--c:' + m.color + '"><span class="rank">' + String(i + 1).padStart(2, "0") + '</span><div class="mname"><span class="dot" style="background:' + m.color + '" aria-hidden="true"></span><div>' + esc(m.name) + (SAMPLE ? ' <span class="tag-sample">SAMPLE</span>' : "") + '<span class="mvendor">7d ' + arrow + '</span></div></div><span class="acc">' + pct(acc) + "<small>" + esc(nTxt) + '</small></span><div class="bar meter"><span style="width:' + (acc == null ? 0 : Math.max(0, Math.min(100, acc))) + "%;background:" + m.color + '"></span></div></li>';
    }).join("");
    var moe = Math.round(196 * Math.sqrt(0.5 / N_HIST));
    $("boardNote").textContent = "Small samples. With n = " + N_HIST + " per model, gaps under about " + moe + " points between two models are within noise.";
  });

  // ---------- GPU card ----------
  function P(r, deg) { var t = deg * Math.PI / 180; return (r * Math.cos(t)).toFixed(2) + " " + (r * Math.sin(t)).toFixed(2); }
  function fan(parent, cx, cy, R, slow) {
    var g = svg("g", { transform: "translate(" + cx + " " + cy + ")" }, parent);
    svg("circle", { r: R, class: "hw-fan-ring" }, g);
    svg("circle", { r: R - 3.5, class: "hw-fan-well" }, g);
    var b = svg("g", { class: "fan-blades" + (slow ? " slow" : "") }, g);
    svg("circle", { r: R - 4, fill: "none", stroke: "none" }, b); // symmetric bbox for a true centre spin
    var ri = 9.5, ro = R - 5.5;
    for (var a = 0; a < 360; a += 40) {
      var d = "M" + P(ri, a) + " Q" + P(ro * 0.62, a + 10) + " " + P(ro, a + 26) +
        " A" + ro + " " + ro + " 0 0 1 " + P(ro, a + 48) +
        " Q" + P(ro * 0.55, a + 36) + " " + P(ri, a + 30) + " Z";
      svg("path", { d: d, class: "hw-blade" }, b);
    }
    svg("circle", { r: 9.5, class: "hw-hub" }, g);
    svg("circle", { r: 3.8, class: "hw-cap" }, g);
  }
  function gpuCard(m, r) {
    var pass = !!(r && r.pass);
    var s = svg("svg", { viewBox: "0 0 320 140", class: "gpu", "aria-hidden": "true", focusable: "false" });
    s.style.setProperty("--c", m.color);
    // 1. PCB, traces, gold PCIe fingers with key notch, backplate edge
    svg("rect", { x: 22, y: 9, width: 292, height: 5, rx: 1.5, class: "hw-backplate" }, s);
    svg("rect", { x: 22, y: 13, width: 292, height: 107, rx: 3, class: "hw-pcb" }, s);
    var notch = 8, fw = 4, fp = 6.1, fx0 = 66;
    svg("rect", { x: fx0 - 4, y: 118, width: notch * fp + 1, height: 14, rx: 1, class: "hw-pcb" }, s);
    svg("rect", { x: fx0 + (notch + 1) * fp - 3, y: 118, width: (30 - notch - 1) * fp + 6, height: 14, rx: 1, class: "hw-pcb" }, s);
    for (var i = 0; i < 31; i++) {
      if (i === notch) continue;
      svg("rect", { x: (fx0 + i * fp).toFixed(1), y: 121, width: fw, height: 10, rx: 0.6, class: "hw-gold" }, s);
    }
    var tr = svg("g", {}, s);
    ["M30 117 H58 l3 -3 H112", "M124 116 H150 l3 -3 H206", "M214 114 H262 l4 4 H306"].forEach(function (d) { svg("path", { d: d, class: "hw-trace" }, tr); });
    [[112, 114], [124, 116], [206, 113], [214, 114], [306, 118], [30, 117]].forEach(function (v) { svg("circle", { cx: v[0], cy: v[1], r: 1.7, class: "hw-via" }, tr); });
    // 6. two 8-pin power headers on top
    [244, 276].forEach(function (hx) {
      svg("rect", { x: hx, y: 1, width: 28, height: 11, rx: 1.5, class: "hw-header" }, s);
      for (var k = 0; k < 4; k++) {
        svg("rect", { x: hx + 3 + k * 6.1, y: 3, width: 3.6, height: 2.6, class: "hw-pin" }, s);
        svg("rect", { x: hx + 3 + k * 6.1, y: 6.8, width: 3.6, height: 2.6, class: "hw-pin" }, s);
      }
    });
    // 2. I/O bracket: 3 display-port cutouts, 1 HDMI-like, vent slots
    svg("rect", { x: 3, y: 3, width: 19, height: 132, rx: 1.5, fill: "url(#arcMetal)", class: "hw-bracket" }, s);
    svg("rect", { x: 8, y: 133, width: 9, height: 6, rx: 1, fill: "url(#arcMetal)" }, s);
    svg("circle", { cx: 12.5, cy: 9, r: 2.2, class: "hw-screw" }, s);
    [20, 34, 48].forEach(function (y) { svg("path", { d: "M8 " + y + " h9 v8 h-6.5 l-2.5 -2.5 z", class: "hw-cut" }, s); });
    svg("path", { d: "M7.5 63 h10 v7 l-1.5 2 h-7 l-1.5 -2 z", class: "hw-cut" }, s);
    for (var vy = 84; vy <= 124; vy += 5) svg("rect", { x: 9, y: vy, width: 7, height: 2.2, rx: 1, class: "hw-cut" }, s);
    // 3. shroud with chamfered corners, accent stripe, etched label
    svg("polygon", { points: "26,17 298,17 312,31 312,104 300,114 42,114 26,100", fill: "url(#arcShroud)", class: "hw-shroud" }, s);
    svg("polyline", { points: "28,19 297,19 310,32", class: "hw-shroud-edge" }, s);
    svg("path", { d: "M46 22 H292 L304 34", class: "hw-accent" }, s);
    svg("path", { d: "M30 96 L44 110 H118", class: "hw-accent soft" }, s);
    // 5. heatsink fin stack through a shroud cutout
    svg("rect", { x: 136, y: 28, width: 64, height: 58, rx: 3, class: "hw-window" }, s);
    for (var f = 0; f < 20; f++) svg("rect", { x: (138.5 + f * 3).toFixed(1), y: 30, width: 1.5, height: 54, fill: "url(#arcFin)" }, s);
    text(s, { x: 168, y: 101, "text-anchor": "middle", class: "hw-label" }, "ARC·" + String(m.name).toUpperCase());
    [[34, 24], [304, 92]].forEach(function (p) { svg("circle", { cx: p[0], cy: p[1], r: 1.8, class: "hw-screw" }, s); });
    // 4. two axial fans, 9 curved blades each
    fan(s, 82, 65.5, 38, !pass);
    fan(s, 254, 65.5, 38, !pass);
    // 7. status LED
    svg("circle", { cx: 290, cy: 106, r: 6, class: "hw-led-glow", fill: pass ? "var(--pass)" : "var(--fail)" }, s);
    svg("circle", { cx: 290, cy: 106, r: 2.6, fill: pass ? "var(--pass)" : "var(--fail)" }, s);
    return s;
  }

  function spark(id, color) {
    var s = svg("svg", { viewBox: "0 0 100 36", preserveAspectRatio: "none", class: "spark", "aria-hidden": "true" });
    var h = S[id].rates.filter(function (v) { return v != null; });
    if (!h.length) return s;
    var mn = Math.min.apply(null, h) - 3, mx = Math.max.apply(null, h) + 3;
    if (mx - mn < 1) { mn -= 5; mx += 5; }
    var sp = Math.max(h.length - 1, 1);
    var pts = h.map(function (v, i) { return (h.length === 1 ? 50 : (i / sp) * 100).toFixed(2) + "," + (34 - ((v - mn) / (mx - mn)) * 32).toFixed(2); });
    if (h.length === 1) {
      var xy = pts[0].split(",");
      svg("circle", { cx: xy[0], cy: xy[1], r: 2, fill: color }, s);
      return s;
    }
    svg("polygon", { points: "0,36 " + pts.join(" ") + " 100,36", fill: color, "fill-opacity": 0.1 }, s);
    svg("polyline", { points: pts.join(" "), fill: "none", stroke: color, "stroke-width": 1.6, "vector-effect": "non-scaling-stroke" }, s);
    return s;
  }

  safe("models", function () {
    var grid = $("modelGrid");
    models.forEach(function (m) {
      var r = R[m.id], s = S[m.id];
      var card = document.createElement("article");
      card.className = "model-card";
      card.style.setProperty("--c", m.color);
      card.appendChild(gpuCard(m, r));
      var rate = s.hasLog
        ? s.passes + "/" + s.attempts + " passed (" + pct(s.attempts ? (s.passes / s.attempts) * 100 : null) + ")"
        : (latestRate(m.id) != null ? pct(latestRate(m.id)) + " latest" : "no history yet");
      var body = document.createElement("div");
      body.innerHTML =
        "<h3>" + esc(m.name) + (SAMPLE ? ' <span class="tag-sample">SAMPLE</span>' : "") + '</h3><div class="vendor">' + esc(m.vendor || "") + "</div>" +
        '<div style="margin-top:10px">' +
        '<div class="kv"><span>Pass rate</span><span>' + esc(rate) + "</span></div>" +
        '<div class="kv"><span>Today</span><span style="color:' + (r.pass ? "var(--pass)" : "var(--fail)") + '">' + (r.pass ? "Pass" : (r.answer == null ? "No answer" : "Fail")) + "</span></div>" +
        '<div class="kv"><span>Avg cost / run</span><span>' + (s.avgCost == null ? "n/a" : usd(s.avgCost)) + "</span></div>" +
        '<div class="kv"><span>Model ID</span><span>' + esc(m.modelId || "n/a") + "</span></div>" +
        '<div class="kv"><span>Endpoint</span><span>' + esc(m.provider || "n/a") + "</span></div>" +
        '<div class="kv"><span>Settings</span><span>' + esc(m.params || "n/a") + "</span></div>" +
        "</div>";
      card.appendChild(body);
      card.appendChild(spark(m.id, m.color));
      var weak = document.createElement("p");
      weak.className = "weak";
      weak.innerHTML = "<b>Typical failure</b>" + esc(m.failure || "Not enough data yet");
      card.appendChild(weak);
      grid.appendChild(card);
    });
  });

  // ---------- fails ----------
  function failChip() {
    return '<svg class="fail-chip" viewBox="0 0 54 54" aria-hidden="true">' +
      '<g stroke="#3a4756" stroke-width="2">' +
      [14, 22, 30, 38].map(function (p) { return '<path d="M' + p + ' 3v6M' + p + ' 45v6M3 ' + p + 'h6M45 ' + p + 'h6"/>'; }).join("") + "</g>" +
      '<rect x="9" y="9" width="36" height="36" rx="4" fill="#111821" stroke="#2a3542" stroke-width="1.4"/>' +
      '<rect x="17" y="17" width="20" height="20" rx="2" fill="#0b0f15" stroke="#3a1a18"/>' +
      '<circle cx="30" cy="24" r="15" fill="url(#arcScorch)"/>' +
      '<path d="M22 31l4-5 3 3 5-7" fill="none" stroke="#ffb3a0" stroke-width="1.2" stroke-linecap="round" opacity=".7"/>' +
      "</svg>";
  }
  safe("fails", function () {
    var wall = $("failWall");
    if (!fails.length) { wall.innerHTML = '<p class="muted">No fails recorded yet.</p>'; return; }
    wall.innerHTML = fails.map(function (x) {
      var m = M[x.model];
      var day = Math.round(num(x.day, 0));
      var code = "FAULT 0x" + (day.toString(16).toUpperCase().padStart(2, "0")) + " · day " + day;
      var d = deltaOf(x.answer, x.gt);
      var loss = x.answer == null ? "no answer" : (d != null ? fmtDelta(d) : (x.loss || "invalid"));
      var rule = x.rule || (x.answer == null ? "no answer" : "outside threshold");
      var facts = isNum(x.gt) ? "best " + x.gt + " " + esc(x.unit || "") + (isNum(x.answer) ? " · answered " + x.answer + " " + esc(x.unit || "") : "") : "";
      var link = "";
      if (day === DAY && R[x.model]) link = '<button type="button" data-trace="' + esc(x.model) + '">Open trace</button>';
      else if (runUrl(day)) link = '<a href="' + esc(runUrl(day)) + '" target="_blank" rel="noopener">Run log</a>';
      return '<article class="fail-card">' + failChip() +
        '<div class="fault-code"><span class="led-f" aria-hidden="true"></span>' + esc(code) + (SAMPLE ? '<span class="tag-sample">SAMPLE</span>' : "") + "</div>" +
        '<div class="fail-top"><span>' + esc(x.category || D.category || "") + "</span><span>rule: " + esc(rule) + "</span></div>" +
        "<h3>" + esc(x.title || "") + '</h3><div class="who"><span class="dot" style="background:' + m.color + '" aria-hidden="true"></span>' + esc(m.name) + '<span class="loss">' + esc(loss) + "</span></div>" +
        (facts || link ? '<p class="facts">' + facts + (facts && link ? " · " : "") + link + "</p>" : "") +
        "</article>";
    }).join("");
    wall.addEventListener("click", function (e) {
      var b = e.target.closest("button[data-trace]");
      if (!b) return;
      selectTrace(b.getAttribute("data-trace"));
      $("trace").scrollIntoView({ behavior: RM ? "auto" : "smooth" });
      var tab = document.querySelector('.trace-tab[aria-selected="true"]');
      if (tab) tab.focus({ preventScroll: true });
    });
  });

  // ---------- motherboard pipeline ----------
  safe("motherboard", function () {
    var s = $("mbSvg");
    var N = Math.max(results.length, 1);
    svg("rect", { x: 4, y: 4, width: 1092, height: 292, rx: 14, class: "mb-pcb" }, s);
    // decorative inner-layer traces
    ["M20 270 H240 l14 -14 H560", "M600 280 H900 l10 -10 H1080", "M20 60 H120 l12 -12 H240", "M720 40 H760 l10 10 H900"].forEach(function (d) { svg("path", { d: d, class: "mb-deco" }, s); });
    [[24, 24], [1076, 24], [24, 276], [1076, 276]].forEach(function (p) { svg("circle", { cx: p[0], cy: p[1], r: 7, class: "mb-hole" }, s); });
    text(s, { x: 44, y: 30, class: "mb-silk" }, "ARC-MB1 · RUN PIPELINE · REV A");
    if (SAMPLE) text(s, { x: 1056, y: 30, "text-anchor": "end", class: "wm" }, "SAMPLE DATA");

    var buses = svg("g", {}, s);
    // 01 task: M.2 NVMe stick
    svg("rect", { x: 34, y: 124, width: 14, height: 52, rx: 2, class: "mb-socket" }, s);
    svg("rect", { x: 44, y: 130, width: 170, height: 40, rx: 3, class: "mb-ssd" }, s);
    for (var gf = 0; gf < 7; gf++) svg("rect", { x: 44, y: 133 + gf * 5, width: 6, height: 3, class: "hw-gold" }, s);
    svg("rect", { x: 60, y: 138, width: 30, height: 24, rx: 2, class: "mb-nand" }, s);
    svg("rect", { x: 98, y: 136, width: 46, height: 28, rx: 2, class: "mb-nand" }, s);
    svg("rect", { x: 152, y: 136, width: 46, height: 28, rx: 2, class: "mb-nand" }, s);
    svg("circle", { cx: 222, cy: 150, r: 5, class: "mb-hole" }, s);
    text(s, { x: 121, y: 154, "text-anchor": "middle", class: "mb-lcd-dim" }, "TASK");
    text(s, { x: 44, y: 120, class: "mb-silk" }, "M.2 · TASK.JSON");

    // 02 models: PCIe x16 slots each holding a mini card
    var slotX = 290, slotW = 220, top = 46, avail = 216;
    var pitch = Math.min(48, avail / N), cardH = Math.min(30, pitch - 12);
    var slotY = [];
    text(s, { x: slotX, y: top - 10, class: "mb-silk" }, "PCIE X16 · " + results.length + " MODELS");
    results.forEach(function (r, i) {
      var m = M[r.model], y = top + i * pitch;
      var sy = y + cardH + 1;
      slotY.push(y + cardH / 2);
      svg("rect", { x: slotX, y: sy, width: slotW, height: 7, rx: 1.5, class: "mb-slot" }, s);
      svg("rect", { x: slotX + slotW - 10, y: sy - 1, width: 10, height: 9, rx: 1.5, class: "mb-latch" }, s);
      var g = svg("g", {}, s);
      g.style.setProperty("--c", m.color);
      svg("rect", { x: slotX + 6, y: y, width: slotW - 22, height: cardH, rx: 3, fill: "url(#arcShroud)", class: "hw-shroud" }, g);
      svg("rect", { x: slotX + 6, y: y, width: 3, height: cardH, fill: m.color }, g);
      svg("line", { x1: slotX + 14, y1: y + 2.5, x2: slotX + slotW - 22, y2: y + 2.5, stroke: m.color, "stroke-width": 1.2, opacity: 0.7 }, g);
      var fr = Math.max(5, cardH / 2 - 3);
      [slotX + 120, slotX + 120 + fr * 2 + 8].forEach(function (fx) {
        svg("circle", { cx: fx, cy: y + cardH / 2, r: fr, class: "hw-fan-ring" }, g);
        for (var b = 0; b < 5; b++) {
          var ang = b * 72;
          svg("path", { d: "M" + fx + " " + (y + cardH / 2) + " m" + P(2, ang) + " q" + P(fr * 0.5, ang + 40) + " " + P(fr - 2, ang + 20), fill: "none", stroke: "#3d4a59", "stroke-width": 1.4 }, g);
        }
        svg("circle", { cx: fx, cy: y + cardH / 2, r: 2, fill: m.color }, g);
      });
      text(g, { x: slotX + 16, y: y + cardH / 2 + 4, class: "mb-lcd-dim" }, String(m.name).toUpperCase());
      svg("circle", { cx: slotX + slotW - 24, cy: y + cardH / 2, r: 2.4, fill: r.pass ? "var(--pass)" : "var(--fail)" }, g);
      // NVMe -> slot bus
      var d = ortho(214, 150, 250, y + cardH / 2, slotX + 6, 5);
      svg("path", { d: d, class: "mb-bus" }, buses);
    });

    // 03 tools: NIC / switch chip with RJ45 jacks
    var nx = 620, ny = 112, ns = 104;
    for (var j = 0; j < 3; j++) {
      var jx = 606 + j * 46;
      svg("rect", { x: jx, y: 26, width: 38, height: 34, rx: 2, class: "mb-jack" }, s);
      svg("path", { d: "M" + (jx + 7) + " 34 h24 v14 h-5 v5 h-14 v-5 h-5 z", class: "mb-jack-in" }, s);
      svg("rect", { x: jx + 3, y: 28, width: 6, height: 3, class: j === 1 ? "mb-led-a" : "mb-led-g" }, s);
      svg("path", { d: "M" + (jx + 19) + " 60 V" + ny, class: "mb-bus" }, buses);
    }
    for (var pn = 0; pn < 12; pn++) {
      var pp = nx + 8 + pn * 8;
      svg("rect", { x: pp, y: ny - 5, width: 4, height: 5, class: "mb-pin" }, s);
      svg("rect", { x: pp, y: ny + ns, width: 4, height: 5, class: "mb-pin" }, s);
      svg("rect", { x: nx - 5, y: ny + 8 + pn * 8, width: 5, height: 4, class: "mb-pin" }, s);
      svg("rect", { x: nx + ns, y: ny + 8 + pn * 8, width: 5, height: 4, class: "mb-pin" }, s);
    }
    svg("rect", { x: nx, y: ny, width: ns, height: ns, rx: 4, class: "mb-chip" }, s);
    svg("rect", { x: nx + 22, y: ny + 22, width: ns - 44, height: ns - 44, rx: 2, class: "mb-die" }, s);
    text(s, { x: nx + ns / 2, y: ny + ns / 2 - 2, "text-anchor": "middle", class: "mb-silk-big" }, "NET");
    text(s, { x: nx + ns / 2, y: ny + ns / 2 + 14, "text-anchor": "middle", class: "mb-silk" }, (D.today.tools || []).length + " TOOLS");
    text(s, { x: nx, y: ny + ns + 24, class: "mb-silk" }, "TOOLS · FROZEN @ " + SLOT_LABEL.toUpperCase());
    // slot -> NIC fan-in (non-crossing lanes)
    var entries = results.map(function (r, i) { return ny + 14 + i * ((ns - 28) / Math.max(N - 1, 1)); });
    var ln = lanes(slotY, entries, false);
    var fanIn = [];
    results.forEach(function (r, i) {
      var d = ortho(slotX + slotW - 16, slotY[i], 546 + ln[i] * 12, entries[i], nx - 5, 5);
      svg("path", { d: d, class: "mb-bus" }, buses);
      fanIn.push(d);
    });

    // 04 check: secure element with padlock die marking
    var ex = 790, ey = 124, es = 80;
    for (var q = 0; q < 8; q++) {
      svg("rect", { x: ex + 8 + q * 9, y: ey - 5, width: 4, height: 5, class: "mb-pin" }, s);
      svg("rect", { x: ex + 8 + q * 9, y: ey + es, width: 4, height: 5, class: "mb-pin" }, s);
    }
    svg("rect", { x: ex, y: ey, width: es, height: es, rx: 4, class: "mb-chip" }, s);
    svg("rect", { x: ex + 26, y: ey + 36, width: 28, height: 22, rx: 3, class: "mb-lock", fill: "none" }, s);
    svg("path", { d: "M" + (ex + 32) + " " + (ey + 36) + " v-6 a8 8 0 0 1 16 0 v6", class: "mb-lock" }, s);
    svg("circle", { cx: ex + 40, cy: ey + 46, r: 2, fill: "var(--pass)" }, s);
    text(s, { x: ex, y: ey + es + 24, class: "mb-silk" }, "CHECK · SE");
    var d1 = "M" + (nx + ns + 5) + " 158 H" + ex, d2 = "M" + (nx + ns + 5) + " 172 H" + ex;
    svg("path", { d: d1, class: "mb-bus" }, buses);
    svg("path", { d: d2, class: "mb-bus" }, buses);

    // 05 score: BMC + LCD readout
    var lx = 924, ly = 96;
    svg("rect", { x: lx, y: ly, width: 150, height: 108, rx: 6, class: "mb-chip" }, s);
    svg("rect", { x: lx + 10, y: ly + 10, width: 130, height: 70, rx: 3, fill: "url(#arcLcd)", class: "mb-lcd" }, s);
    text(s, { x: lx + 18, y: ly + 28, class: "mb-lcd-dim" }, "SCORE · DAY " + DAY);
    text(s, { x: lx + 18, y: ly + 50, class: "mb-lcd-text" }, "PASS " + passCount + "/" + results.length);
    text(s, { x: lx + 18, y: ly + 70, class: "mb-lcd-text" }, "THR " + THR + "%");
    svg("circle", { cx: lx + 18, cy: ly + 94, r: 3, class: "led ok" }, s);
    svg("circle", { cx: lx + 30, cy: ly + 94, r: 3, class: "led-dim" }, s);
    text(s, { x: lx + 42, y: ly + 97, class: "mb-silk" }, "BMC");
    var d3 = "M" + (ex + es) + " 150 H" + lx, d4 = "M" + (ex + es) + " 164 H" + lx;
    svg("path", { d: d3, class: "mb-bus" }, buses);
    svg("path", { d: d4, class: "mb-bus" }, buses);

    // packet dots on the buses
    var pk = svg("g", {}, s);
    fanIn.forEach(function (d, i) { packets(pk, d, "mb-packet", 2.6 + i * 0.25, 1, i * 0.3); });
    [d1, d2, d3, d4].forEach(function (d, i) { packets(pk, d, "mb-packet", 1.6 + i * 0.2, 1, i * 0.4); });
    applyZone($("mbZone"));
  });

  // ---------- roadmap ----------
  safe("roadmap", function () {
    $("roadDay").textContent = "Day " + DAY + " of " + TOTAL;
    $("roadFill").style.width = (DAY / TOTAL) * 100 + "%";
    $("roadmap").innerHTML = (D.roadmap || []).map(function (p) {
      var now = DAY >= p.from && DAY <= p.to;
      return '<div class="phase' + (now ? " now" : "") + '"><div class="days">Days ' + esc(p.from) + "–" + esc(p.to) + (now ? " · now" : "") + "</div><h3>" + esc(p.name) + "</h3><p>" + esc(p.desc) + "</p>" +
        (p.verify ? '<p class="pv"><b>Check:</b> ' + esc(p.verify) + "</p>" : "") + "</div>";
    }).join("");
  });

  // ---------- meters animate in ----------
  safe("meters", function () {
    var els = Array.prototype.slice.call(document.querySelectorAll(".meter"));
    if (RM || !("IntersectionObserver" in window)) return;
    els.forEach(function (el) { el.classList.add("meter-wait"); });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        en.target.classList.remove("meter-wait");
        io.unobserve(en.target);
      });
    }, { threshold: 0.2 });
    els.forEach(function (el) { io.observe(el); });
  });

  safe("zones", watchZones);

  // ---------- submit ----------
  safe("form", function () {
    var form = $("taskForm");
    var FIELD = { eTask: "fTask", eCheck: "fCheck" };
    function setErr(id, msg) {
      $(id).textContent = msg || "";
      var f = $(FIELD[id]);
      if (msg) f.setAttribute("aria-invalid", "true"); else f.removeAttribute("aria-invalid");
    }
    $("fTask").addEventListener("input", function () { setErr("eTask"); });
    $("fCheck").addEventListener("input", function () { setErr("eCheck"); });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var task = $("fTask").value.trim().slice(0, 1500), check = $("fCheck").value.trim().slice(0, 300), handle = $("fHandle").value.trim().slice(0, 40);
      var first = null;
      setErr("eTask"); setErr("eCheck"); $("eForm").textContent = "";
      if (task.length < 15) { setErr("eTask", "Describe the task in at least 15 characters."); first = first || "fTask"; }
      if (check.length < 8) { setErr("eCheck", "Tell us how the answer can be verified."); first = first || "fCheck"; }
      if (first) { $(first).focus(); return; }
      if (!REPO_OK) { $("eForm").textContent = "Submissions open at launch. The public repo isn't live yet."; return; }
      var body = "**Task**\n" + task + "\n\n**How to verify**\n" + check + "\n\n**Submitted by**\n" + (handle || "anonymous");
      var url = REPO.replace(/\/$/, "") + "/issues/new?labels=task-submission&title=" + encodeURIComponent("[task] " + task.slice(0, 60)) + "&body=" + encodeURIComponent(body);
      window.open(url, "_blank", "noopener");
    });
  });
})();
