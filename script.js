/* =========================================================================
   KiroBot — Automated Inspection & Sorting Dashboard
   Pure HTML/CSS/JS. No backend, no external libraries.
   ========================================================================= */

(() => {
  "use strict";

  /* ----------------------------- Canvas setup ---------------------------- */
  const canvas = document.getElementById("factory");
  const ctx = canvas.getContext("2d");

  // Logical drawing size (matches the canvas width/height attributes).
  const W = canvas.width;   // 900
  const H = canvas.height;  // 420

  // Support high-DPI screens for crisp rendering.
  function setupHiDPI() {
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.height = "auto";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  setupHiDPI();

  /* ------------------------------ Geometry ------------------------------- */
  const BELT = {
    x: 40,
    y: 250,
    width: W - 220,   // leave room on the right for the sorting bins
    height: 56,
  };
  const SENSOR_X = BELT.x + BELT.width * 0.55; // inspection beam position
  const SORT_X = BELT.x + BELT.width - 20;     // where parts divert to bins
  const PART_RADIUS = 20;
  const MIN_GAP = PART_RADIUS * 2 + 14;        // min center-to-center spacing
  const SCAN_WINDOW = PART_RADIUS;             // beam half-width for scanning

  // Throughput safeguard: this line is rated for a limited batch. Once more
  // than THROUGHPUT_LIMIT pieces have been processed, the sim treats it as an
  // overflow condition and auto-triggers the (simulated) emergency stop.
  const THROUGHPUT_LIMIT = 45;                 // max material pieces per run

  // Inspection modes trade scan dwell time against throughput. High-speed
  // scans are quicker but less reliable, modeled as a small accuracy penalty.
  // `beltBoost` multiplies belt speed and tightens the part cadence so
  // High-Speed runs at a realistic production pace (brisk, not frantic).
  const MODES = {
    normal: { dwell: 10, accuracyPenalty: 0, beltBoost: 1.0,  label: "Normal" },
    high:   { dwell: 4,  accuracyPenalty: 8, beltBoost: 1.6,  label: "High-Speed" },
  };

  /* ------------------------------- Audio --------------------------------- */
  // A tiny synth built on the Web Audio API — no sound files needed. The audio
  // sensor emits an alert beep when the vision sensor detects a defective part.
  const audio = (() => {
    let ctxA = null;
    let master = null;
    let enabled = true;

    // Browsers require audio to start from a user gesture; we lazily create the
    // context on the first interaction (Start / Demo / toggle).
    function ensure() {
      if (!ctxA) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;          // audio unsupported — fail silently
        ctxA = new AC();
        master = ctxA.createGain();
        master.gain.value = 0.9;
        master.connect(ctxA.destination);
      }
      if (ctxA.state === "suspended") ctxA.resume();
      return true;
    }

    /** Play a tone. freq in Hz, dur in seconds, type is an oscillator wave. */
    function tone(freq, dur, type = "square", gain = 0.18) {
      if (!enabled || !ensure()) return;
      const t0 = ctxA.currentTime;
      const osc = ctxA.createOscillator();
      const g = ctxA.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      // Quick attack + exponential release for a clean "beep" envelope.
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(g);
      g.connect(master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.02);
    }

    return {
      // Warning beep for a detected defect: two short high square-wave pips.
      defectBeep() {
        tone(880, 0.12, "square", 0.2);
        setTimeout(() => tone(1240, 0.14, "square", 0.2), 90);
      },
      // Soft confirmation blip for a part that passes (subtle, optional).
      passBlip() {
        tone(523.25, 0.07, "sine", 0.07);
      },
      // Harsh descending klaxon for the (simulated) emergency stop.
      estopAlarm() {
        tone(440, 0.22, "sawtooth", 0.22);
        setTimeout(() => tone(330, 0.3, "sawtooth", 0.22), 200);
      },
      setEnabled(v) { enabled = v; if (v) ensure(); },
      isEnabled() { return enabled; },
      // Prime the context from a user gesture.
      unlock() { ensure(); },
    };
  })();

  // Accept bin sits below the belt, reject bin rises to an upper chute.
  // Both are kept fully inside the 900x420 canvas.
  const ACCEPT_BIN = { x: SORT_X + 30, y: BELT.y + 72, w: 120, h: 84 };
  const REJECT_BIN = { x: SORT_X + 30, y: BELT.y - 170, w: 120, h: 84 };

  /* --------------------------- Part definitions -------------------------- */
  // Plastic resin types. Each has a distinct resin color and a canonical
  // shape so operators can tell materials apart at a glance.
  // `mass` = grams of resin per part; `recyclability` = fraction recovered when
  // the part is recycled (PP/PE/HDPE recycle well; PLA/PMMA are harder).
  const MATERIALS = [
    { code: "HDPE", name: "High-Density Polyethylene", hex: "#4f9cff", shape: "hexagon",  mass: 25, recyclability: 0.90 },
    { code: "PLA",  name: "Polylactic Acid",           hex: "#3fd07f", shape: "triangle", mass: 18, recyclability: 0.45 },
    { code: "PMMA", name: "Acrylic (PMMA)",            hex: "#b57cff", shape: "square",   mass: 30, recyclability: 0.60 },
    { code: "PE",   name: "Polyethylene",              hex: "#ffcb47", shape: "circle",   mass: 20, recyclability: 0.88 },
    { code: "PP",   name: "Polypropylene",             hex: "#2fd4d4", shape: "pentagon", mass: 22, recyclability: 0.85 },
  ];
  const MATERIAL_BY_CODE = Object.fromEntries(MATERIALS.map((m) => [m.code, m]));
  const OFF_SPEC_HEX = "#717d8c"; // discolored/contaminated resin tint

  let partSeq = 0;

  /**
   * Build a part from a material plus an optional explicit defect. Used by both
   * the random generator and the scripted demo sequence.
   *
   * @param {object} material  one of MATERIALS
   * @param {null|"color"|"cracked"|"malformed"} defect  defect to apply
   */
  function makePart(material, defect) {
    return {
      id: ++partSeq,
      x: BELT.x - PART_RADIUS - 10,
      y: BELT.y + BELT.height / 2,
      vy: 0,
      material,
      shape: material.shape,
      cracked: defect === "cracked",
      malformed: defect === "malformed",
      discolored: defect === "color",
      hex: defect === "color" ? OFF_SPEC_HEX : material.hex,
      defective: defect !== null && defect !== undefined,
      outcome: null,          // "TP" | "TN" | "FP" | "FN" (set at inspection)
      // Inspection lifecycle flags (prevent double-processing):
      phase: "approaching", // approaching -> scanning -> inspected
      inspected: false,     // becomes true exactly once, after a scan
      result: null,         // "PASS" | "FAIL"
      verdict: null,        // "accept" | "reject" (routing)
      reason: null,         // human-readable sensor finding
      scanTimer: 0,         // frames the part has dwelled under the beam
      state: "belt",        // belt | sorting | done
      scanFlash: 0,         // frames of highlight after inspection
      rotation: Math.random() * Math.PI,
    };
  }

  /**
   * Create a random part. Material is uniform-random; the chance it is
   * manufactured defective follows the user-set incoming defect rate, and a
   * defective part gets exactly one of three defect types.
   */
  function createPart() {
    const material = MATERIALS[(Math.random() * MATERIALS.length) | 0];
    let defect = null;
    if (Math.random() * 100 < state.defectRate) {
      defect = ["color", "cracked", "malformed"][Math.floor(Math.random() * 3)];
    }
    return makePart(material, defect);
  }

  /**
   * Simulated inspection sensor.
   *
   * Models three independent QC checks a real optical/vision sensor might run
   * on a part, producing a "ground-truth" reading (PASS only if every check is
   * within spec). The sensor's configured accuracy then determines whether it
   * reports that truth correctly: with probability (1 - effectiveAccuracy) it
   * misreads and flips the verdict, just as a real imperfect sensor would.
   *
   * @returns {{result:"PASS"|"FAIL", verdict:"accept"|"reject",
   *            reason:string, misread:boolean}}
   */
  function runSensor(part) {
    const failures = [];
    if (part.discolored) failures.push("discolored resin");
    if (part.cracked) failures.push("cracked body");
    if (part.malformed) failures.push("malformed shape");

    const trulyPass = failures.length === 0;

    // Effective accuracy = slider value minus the current mode's penalty,
    // clamped to a sane range, expressed as a 0..1 probability.
    const penalty = MODES[state.mode].accuracyPenalty;
    const effAccuracy = Math.max(50, Math.min(100, state.accuracy - penalty)) / 100;

    const misread = Math.random() > effAccuracy;
    const reportedPass = misread ? !trulyPass : trulyPass;

    let reason;
    if (reportedPass) {
      reason = misread ? "within spec (missed defect)" : "within spec";
    } else {
      reason = trulyPass
        ? "false reject (sensor error)"
        : failures.join(", ");
    }

    return {
      result: reportedPass ? "PASS" : "FAIL",
      verdict: reportedPass ? "accept" : "reject",
      reason,
      misread,
    };
  }

  /* ------------------------------- State --------------------------------- */
  const state = {
    status: "idle",          // idle | running | paused | estopped
    estop: false,            // latched emergency-stop (blocks all operation)
    autoRecoverTimer: null,  // pending auto clear-&-reset timeout (overflow)
    runFrames: 0,            // frames spent in the running state (for rate calc)
    parts: [],
    spawnTimer: 0,
    spawnInterval: 95,       // frames between parts (adjusted by speed)
    speed: 5,                // 1..10 from slider
    accuracy: 100,           // 50..100 sensor accuracy (%)
    mode: "normal",          // "normal" | "high" inspection mode
    defectRate: 25,          // % of incoming parts manufactured defective
    counters: {
      total: 0,              // total parts processed (inspected)
      accepted: 0,           // reported PASS (routed to accept bin)
      rejected: 0,           // reported FAIL (routed to reject bin)
      // Confusion-matrix outcomes (reported vs. ground truth):
      truePass: 0,           // good part correctly accepted  (TP)
      trueReject: 0,         // defective part correctly rejected (TN)
      falsePositive: 0,      // good part wrongly rejected (FP) — wasted material
      falseNegative: 0,      // defective part wrongly accepted (FN) — escaped defect
    },
    // Recycling: grams of resin recovered from rejected parts, by material
    // code, plus the total rejected mass fed to the recycler.
    recycle: { byCode: {}, recovered: 0, rejectedMass: 0 },
    sensorBusyId: null,      // id of the part currently under the sensor (lock)
    beltOffset: 0,           // for the moving belt texture
    settledAccept: [],       // visual stack in accept bin
    settledReject: [],       // visual stack in reject bin
    demo: false,             // demo-sequence mode active
    demoQueue: [],           // pending scripted parts
    demoTimer: 0,            // frames until next scripted part is released
    alarmFlash: 0,           // frames of audio-sensor alarm highlight remaining
    // Sorting robot arm (animated). Angles are eased toward targets each frame.
    robot: {
      reach: 0,              // 0 = home, 1 = fully extended to a bin
      target: 0,             // desired reach
      dir: "accept",         // which bin the arm is serving
      grip: 0,               // 0 = open, 1 = closed (holding a part)
    },
  };

  /* ------------------------------- DOM refs ------------------------------ */
  const el = {
    startBtn: document.getElementById("startBtn"),
    pauseBtn: document.getElementById("pauseBtn"),
    resetBtn: document.getElementById("resetBtn"),
    demoBtn: document.getElementById("demoBtn"),
    audioBtn: document.getElementById("audioBtn"),
    audioIco: document.getElementById("audioIco"),
    estopBtn: document.getElementById("estopBtn"),
    clearBtn: document.getElementById("clearBtn"),
    estopBanner: document.getElementById("estopBanner"),
    estopTitle: document.getElementById("estopTitle"),
    estopReason: document.getElementById("estopReason"),
    speed: document.getElementById("speed"),
    accuracy: document.getElementById("accuracy"),
    accuracyValue: document.getElementById("accuracyValue"),
    defectRate: document.getElementById("defectRate"),
    defectRateValue: document.getElementById("defectRateValue"),
    modeNormal: document.getElementById("modeNormal"),
    modeHigh: document.getElementById("modeHigh"),
    modeHint: document.getElementById("modeHint"),
    statusPill: document.getElementById("statusPill"),
    statusLabel: document.getElementById("statusLabel"),
    statTotal: document.getElementById("statTotal"),
    statAccepted: document.getElementById("statAccepted"),
    statRejected: document.getElementById("statRejected"),
    statRate: document.getElementById("statRate"),
    barAccepted: document.getElementById("barAccepted"),
    barRejected: document.getElementById("barRejected"),
    propValue: document.getElementById("propValue"),
    propFill: document.getElementById("propFill"),
    propRate: document.getElementById("propRate"),
    statMaterialRejected: document.getElementById("statMaterialRejected"),
    statFalsePos: document.getElementById("statFalsePos"),
    statFalseNeg: document.getElementById("statFalseNeg"),
    statEscapeRate: document.getElementById("statEscapeRate"),
    wasteIndicator: document.getElementById("wasteIndicator"),
    wasteScore: document.getElementById("wasteScore"),
    wasteFill: document.getElementById("wasteFill"),
    wasteNote: document.getElementById("wasteNote"),
    recycle: document.getElementById("recycle"),
    recycleScore: document.getElementById("recycleScore"),
    recycleFill: document.getElementById("recycleFill"),
    recycleBreakdown: document.getElementById("recycleBreakdown"),
    recycleNote: document.getElementById("recycleNote"),
    materialLegend: document.getElementById("materialLegend"),
    log: document.getElementById("log"),
  };

  /** Render the material-type legend chips once at startup. */
  function renderMaterialLegend() {
    el.materialLegend.innerHTML = MATERIALS.map(
      (m) =>
        `<span class="mat-chip" title="${m.name}">` +
        `<i class="mat-dot" style="background:${m.hex}"></i>` +
        `<b>${m.code}</b></span>`
    ).join("");
  }

  /* --------------------------- Control handlers -------------------------- */
  function setStatus(status) {
    state.status = status;
    el.statusPill.dataset.state = status;
    el.statusLabel.textContent =
      status === "estopped"
        ? "E-Stop"
        : status.charAt(0).toUpperCase() + status.slice(1);

    const locked = state.estop; // emergency stop blocks normal operation

    el.startBtn.disabled = locked || status === "running";
    el.pauseBtn.disabled = locked || status !== "running";
    el.demoBtn.disabled = locked;
    el.pauseBtn.innerHTML =
      status === "paused"
        ? '<span class="ico">▶</span> Resume'
        : '<span class="ico">❚❚</span> Pause';
  }

  el.startBtn.addEventListener("click", () => {
    if (state.estop) return;    // locked out until cleared + reset
    audio.unlock();             // prime audio from this user gesture
    if (state.demo) stopDemo(); // leaving demo for free-run mode
    if (state.status === "running") return;
    setStatus("running");
  });

  el.pauseBtn.addEventListener("click", () => {
    if (state.estop) return;
    if (state.status === "running") setStatus("paused");
    else if (state.status === "paused") setStatus("running");
  });

  el.resetBtn.addEventListener("click", () => {
    if (state.estop) return;    // must clear the E-stop before resetting
    stopDemo();
    reset();
  });

  el.demoBtn.addEventListener("click", () => {
    if (state.estop) return;
    if (state.demo) {
      stopDemo();
      setStatus("idle");
    } else {
      startDemo();
    }
  });

  /* ------------------------- Emergency stop (SIM) ------------------------ */
  // NOTE: This is a SOFTWARE SIMULATION of an emergency stop for the virtual
  // line only. It is NOT a functional-safety device and must never be relied
  // on to protect people or real equipment.
  /**
   * Engage the (simulated) emergency stop.
   * @param {"manual"|"overflow"} [cause] what tripped the stop; used only to
   *        tailor the on-screen message.
   */
  const AUTO_RECOVER_MS = 2200; // pause shown before auto clear & reset

  function engageEstop(cause = "manual") {
    if (state.estop) return;
    state.estop = true;
    stopDemo();                 // abort any scripted run
    audio.unlock();
    audio.estopAlarm();         // audible alert
    setStatus("estopped");      // halts motion (update() bails while estopped)
    el.estopBtn.classList.add("engaged");
    el.estopBtn.setAttribute("aria-pressed", "true");
    el.clearBtn.disabled = false;

    // Tailor the banner text to the cause.
    const auto = cause === "overflow";
    el.estopBtn.classList.toggle("auto", auto);
    el.estopReason.textContent = auto
      ? `Throughput limit of ${THROUGHPUT_LIMIT} pieces reached. Auto-recovering — the line will clear, reset, and restart automatically…`
      : "All simulated motion halted. Clear the E-Stop to reset the line.";
    el.estopTitle.textContent = auto
      ? "AUTO E-STOP — OVERFLOW"
      : "EMERGENCY STOP ENGAGED";
    el.estopBanner.hidden = false;

    // On a throughput overflow, automatically clear, reset, and resume after a
    // short pause so the line cycles on its own. A manual Clear cancels it.
    if (auto) {
      state.autoRecoverTimer = setTimeout(() => {
        state.autoRecoverTimer = null;
        clearEstop({ resume: true });
      }, AUTO_RECOVER_MS);
    }
  }

  /**
   * Clear the latched E-stop and reset the line.
   * @param {{resume?: boolean}} [opts] if resume is true (auto-recovery), the
   *        line restarts running instead of returning to idle.
   */
  function clearEstop(opts = {}) {
    if (!state.estop) return;

    // Cancel any pending auto-recovery (e.g. user clicked Clear first).
    if (state.autoRecoverTimer) {
      clearTimeout(state.autoRecoverTimer);
      state.autoRecoverTimer = null;
    }

    state.estop = false;
    el.estopBtn.classList.remove("engaged", "auto");
    el.estopBtn.setAttribute("aria-pressed", "false");
    el.clearBtn.disabled = true;
    el.estopBanner.hidden = true;
    reset(); // fresh idle state, counters zeroed

    // Auto-recovery restarts the line so it keeps cycling; a manual clear
    // leaves it idle for the operator to start again.
    if (opts.resume === true) setStatus("running");
  }

  el.estopBtn.addEventListener("click", () => engageEstop("manual"));
  el.clearBtn.addEventListener("click", () => clearEstop());

  // Spacebar is a convenient panic key while the canvas area is focused.
  document.addEventListener("keydown", (e) => {
    if (e.code === "Space" && !state.estop) {
      const tag = (e.target.tagName || "").toLowerCase();
      if (tag !== "input" && tag !== "button") {
        e.preventDefault();
        engageEstop();
      }
    }
  });

  el.audioBtn.addEventListener("click", () => {
    const on = !audio.isEnabled();
    audio.setEnabled(on);
    el.audioBtn.classList.toggle("active", on);
    el.audioBtn.classList.toggle("muted", !on);
    el.audioBtn.setAttribute("aria-pressed", String(on));
    el.audioIco.textContent = on ? "🔊" : "🔇";
    if (on) audio.defectBeep(); // quick confirmation the sensor is live
  });

  el.speed.addEventListener("input", (e) => {
    state.speed = Number(e.target.value);
  });

  el.accuracy.addEventListener("input", (e) => {
    state.accuracy = Number(e.target.value);
    el.accuracyValue.textContent = state.accuracy + "%";
  });

  el.defectRate.addEventListener("input", (e) => {
    state.defectRate = Number(e.target.value);
    el.defectRateValue.textContent = state.defectRate + "%";
  });

  function setMode(mode) {
    if (!MODES[mode]) return;
    state.mode = mode;

    const normalActive = mode === "normal";
    el.modeNormal.classList.toggle("active", normalActive);
    el.modeHigh.classList.toggle("active", !normalActive);
    el.modeNormal.setAttribute("aria-checked", String(normalActive));
    el.modeHigh.setAttribute("aria-checked", String(!normalActive));

    el.modeHint.textContent = normalActive
      ? "Thorough scan dwell for best reliability."
      : "Runs the line at factory pace — faster belt and throughput, slightly higher misread risk.";
  }

  el.modeNormal.addEventListener("click", () => setMode("normal"));
  el.modeHigh.addEventListener("click", () => setMode("high"));

  function reset() {
    state.parts = [];
    state.spawnTimer = 0;
    state.counters = {
      total: 0, accepted: 0, rejected: 0,
      truePass: 0, trueReject: 0, falsePositive: 0, falseNegative: 0,
    };
    state.recycle = { byCode: {}, recovered: 0, rejectedMass: 0 };
    state.sensorBusyId = null;
    state.runFrames = 0;
    state.settledAccept = [];
    state.settledReject = [];
    state.demoQueue = [];
    state.demoTimer = 0;
    state.robot.reach = 0;
    state.robot.grip = 0;
    partSeq = 0;
    setStatus("idle");
    updateStats();
    clearLog();
  }

  /* --------------------------- Stats + logging --------------------------- */
  function updateStats() {
    const c = state.counters;
    const { total, accepted, rejected, falsePositive, falseNegative } = c;

    // Show processed count against the throughput cap (auto E-stop over cap).
    el.statTotal.textContent = total + " / " + THROUGHPUT_LIMIT;
    el.statAccepted.textContent = accepted;
    el.statRejected.textContent = rejected;

    // Reported defect (reject) rate.
    const rate = total === 0 ? 0 : (rejected / total) * 100;
    el.statRate.textContent = rate.toFixed(1) + "%";

    const accPct = total === 0 ? 0 : (accepted / total) * 100;
    const rejPct = total === 0 ? 0 : (rejected / total) * 100;
    el.barAccepted.style.width = accPct + "%";
    el.barRejected.style.width = rejPct + "%";

    // --- Simulation quality metrics ---
    // Total material rejected is everything routed to the reject bin.
    el.statMaterialRejected.textContent = rejected;
    // False positives: good parts wrongly rejected (avoidable material waste).
    el.statFalsePos.textContent = falsePositive;
    // Defects that passed inspection (false negatives / escaped defects).
    el.statFalseNeg.textContent = falseNegative;

    // Escape rate: of all defective parts processed, how many slipped through.
    const defectsSeen = c.trueReject + falseNegative; // all defective parts
    const escapeRate = defectsSeen === 0 ? 0 : (falseNegative / defectsSeen) * 100;
    el.statEscapeRate.textContent = escapeRate.toFixed(1) + "%";

    updateWasteIndicator();
    updateRecycling();
    updatePropagationRate();
  }

  /**
   * Propagation rate: how fast material propagates through the line, derived
   * from throughput — pieces processed per minute over actual running time.
   * Also drives a progress bar toward the throughput cap, which turns red as
   * the line approaches the auto E-stop limit.
   */
  function updatePropagationRate() {
    const total = state.counters.total;
    const seconds = state.runFrames / 60;              // assume ~60 fps
    const perMin = seconds > 0 ? (total / seconds) * 60 : 0;

    el.propValue.textContent = Math.round(perMin) + " pcs/min";

    const pct = Math.min(100, (total / THROUGHPUT_LIMIT) * 100);
    el.propFill.style.width = pct + "%";

    // Color the bar green -> amber -> red as it nears the cap.
    let level = "ok";
    if (pct >= 90) level = "danger";
    else if (pct >= 70) level = "warn";
    el.propRate.dataset.level = level;
  }

  /**
   * Waste reduction indicator.
   *
   * "Waste" here is good material thrown away — i.e. false positives, where a
   * perfectly good part is rejected. A line that never discards good parts has
   * 100% waste reduction. We score it as the share of processed parts that were
   * NOT wasted this way, and band it into good / ok / poor.
   */
  function updateWasteIndicator() {
    const c = state.counters;
    const total = c.total;

    if (total === 0) {
      el.wasteIndicator.dataset.level = "none";
      el.wasteScore.textContent = "—";
      el.wasteFill.style.width = "0%";
      el.wasteNote.textContent =
        "Start the line to measure how efficiently material is used.";
      return;
    }

    const wastedGood = c.falsePositive;
    const score = ((total - wastedGood) / total) * 100; // % material preserved
    el.wasteScore.textContent = score.toFixed(1) + "%";
    el.wasteFill.style.width = score + "%";

    let level;
    if (score >= 95) level = "good";
    else if (score >= 85) level = "ok";
    else level = "poor";
    el.wasteIndicator.dataset.level = level;

    el.wasteNote.textContent =
      `${wastedGood} good part${wastedGood === 1 ? "" : "s"} wrongly rejected, ` +
      `${c.falseNegative} defect${c.falseNegative === 1 ? "" : "s"} passed. ` +
      `Raise sensor accuracy to cut material waste.`;
  }

  /**
   * Recycling component. Rejected parts are sent to the recycler, which
   * recovers a fraction of each part's resin mass (by material type). Shows the
   * total grams recovered, the overall recovery efficiency, and a per-material
   * breakdown bar.
   */
  function updateRecycling() {
    const rec = state.recycle;
    const recovered = rec.recovered;

    // Total recovered mass (grams), rounded.
    el.recycleScore.textContent = Math.round(recovered) + " g";

    // Recovery efficiency = recovered / total rejected mass.
    const eff = rec.rejectedMass > 0 ? (recovered / rec.rejectedMass) * 100 : 0;
    el.recycleFill.style.width = eff + "%";

    let level = "none";
    if (rec.rejectedMass > 0) {
      if (eff >= 80) level = "good";
      else if (eff >= 60) level = "ok";
      else level = "poor";
    }
    el.recycle.dataset.level = level;

    // Per-material breakdown chips (only materials actually recovered).
    const chips = MATERIALS.filter((m) => rec.byCode[m.code] > 0).map((m) => {
      const grams = Math.round(rec.byCode[m.code]);
      return (
        `<span class="recycle-chip" title="${m.name} — ${Math.round(m.recyclability * 100)}% recyclable">` +
        `<i class="recycle-dot" style="background:${m.hex}"></i>` +
        `${m.code} ${grams}g</span>`
      );
    });
    el.recycleBreakdown.innerHTML = chips.join("");

    el.recycleNote.textContent =
      rec.rejectedMass > 0
        ? `${Math.round(recovered)} g recovered of ${Math.round(rec.rejectedMass)} g rejected (${eff.toFixed(0)}% recovery).`
        : "Rejected parts are routed to the recycler and recovered by resin type.";
  }

  function clearLog() {
    el.log.innerHTML = '<li class="log-empty">Awaiting first part…</li>';
  }

  function addLog(part) {
    const empty = el.log.querySelector(".log-empty");
    if (empty) empty.remove();

    const li = document.createElement("li");
    li.className = "new";
    const verdictClass = part.result === "PASS" ? "accept" : "reject";
    const tagText = part.result; // "PASS" | "FAIL"
    const misreadBadge = part.misread
      ? '<span class="tag misread" title="Sensor misclassified this part">⚠ misread</span>'
      : "";

    li.innerHTML =
      `<span class="tag ${verdictClass}">${tagText}</span>` +
      `<span>#${String(part.id).padStart(3, "0")} ` +
      `<b class="mat">${part.material.code}</b></span>` +
      `<span class="desc">— ${part.reason}</span>` +
      misreadBadge;

    el.log.prepend(li);

    // Keep the log from growing unbounded.
    while (el.log.children.length > 40) {
      el.log.removeChild(el.log.lastChild);
    }
  }

  /* ----------------------------- Simulation ------------------------------ */
  function speedFactor() {
    // Map slider 1..10 to a pixel-per-frame belt speed, then apply the current
    // inspection mode's belt boost (High-Speed runs the line faster).
    return (0.6 + state.speed * 0.42) * MODES[state.mode].beltBoost;
  }

  /** True if there's room at the infeed to release another part. */
  function infeedClear() {
    const spawnX = BELT.x - PART_RADIUS - 10;
    let nearest = Infinity;
    for (const p of state.parts) {
      if (p.state === "belt" && p.x < nearest) nearest = p.x;
    }
    return nearest === Infinity || nearest - spawnX >= MIN_GAP;
  }

  /**
   * Find the nearest belt part ahead of the part at index `idx` (larger x),
   * used to keep a safe following gap. Returns null if the lane is clear.
   */
  function findAheadOnBelt(idx) {
    const p = state.parts[idx];
    let ahead = null;
    for (let j = 0; j < state.parts.length; j++) {
      if (j === idx) continue;
      const q = state.parts[j];
      if (q.state !== "belt") continue;
      if (q.x > p.x && (ahead === null || q.x < ahead.x)) ahead = q;
    }
    return ahead;
  }

  function update() {
    if (state.status !== "running") return;

    const sp = speedFactor();
    state.beltOffset = (state.beltOffset + sp) % 40;
    state.runFrames += 1; // accumulate running time for the propagation rate
    if (state.alarmFlash > 0) state.alarmFlash -= 1;

    // Spawn new parts on a cadence that scales with speed, but never so close
    // that parts would overlap at the infeed. The newest belt part must have
    // cleared a full gap before another is released.
    // Random spawning is disabled in demo mode (parts come from the script).
    if (!state.demo) {
      state.spawnTimer += 1;
      // Release parts faster in High-Speed so throughput actually rises rather
      // than the faster belt just spreading parts further apart.
      const base = Math.max(45, state.spawnInterval - state.speed * 4);
      const interval = base / MODES[state.mode].beltBoost;
      if (state.spawnTimer >= interval && infeedClear()) {
        state.spawnTimer = 0;
        state.parts.push(createPart());
      }
    }

    // Parts earlier in the array are further down the belt. Walk front-to-back
    // so each part can see the one ahead of it for spacing.
    for (let i = 0; i < state.parts.length; i++) {
      const p = state.parts[i];
      if (p.scanFlash > 0) p.scanFlash -= 1;

      if (p.state === "belt") {
        // Desired advance this frame. Both the spacing rule and the sensor
        // wait rule act as UPPER BOUNDS on how far the part may advance — they
        // can only hold a part back, never shove it forward (which would cause
        // overlap). We collect the tightest bound and clamp once.
        let nextX = p.x + sp;

        // Overlap prevention: don't close within MIN_GAP of the part ahead
        // while that part is still on the belt (i.e. hasn't diverted yet).
        const ahead = findAheadOnBelt(i);
        if (ahead) {
          nextX = Math.min(nextX, ahead.x - MIN_GAP);
        }

        // If an un-inspected part reaches the sensor while another part holds
        // the sensor lock, it waits just before the beam instead of rolling
        // through un-scanned. This guarantees every part is inspected once.
        if (!p.inspected &&
            state.sensorBusyId !== null && state.sensorBusyId !== p.id) {
          nextX = Math.min(nextX, SENSOR_X - SCAN_WINDOW);
        }

        // Never move backwards (clamps combine to at most the current x).
        p.x = Math.max(p.x, nextX);

        // --- Simulated inspection sensor ---------------------------------
        // A part begins a scan when its center enters the beam window, and
        // only one part may occupy the sensor at a time (sensor lock). Once a
        // part has acquired the lock it finishes its scan even if the belt
        // carries it slightly past the window, so fast belts never skip a part.
        const reachedBeam = p.x >= SENSOR_X - SCAN_WINDOW;
        const holdingSensor = state.sensorBusyId === p.id;

        if (!p.inspected && reachedBeam &&
            (state.sensorBusyId === null || holdingSensor)) {
          // Acquire the sensor and accumulate dwell time.
          state.sensorBusyId = p.id;
          p.phase = "scanning";
          p.scanTimer += 1;

          // Commit the reading once the dwell completes — exactly once. The
          // required dwell depends on the selected inspection mode.
          if (p.scanTimer >= MODES[state.mode].dwell) {
            const reading = runSensor(p);
            p.inspected = true;        // guard against re-processing
            p.phase = "inspected";
            p.result = reading.result; // "PASS" | "FAIL"
            p.verdict = reading.verdict;
            p.reason = reading.reason;
            p.misread = reading.misread;
            p.scanFlash = 18;

            // Classify the outcome against ground truth and update all
            // counters immediately after the completed inspection.
            const c = state.counters;
            c.total += 1;
            const reportedPass = p.result === "PASS";
            if (reportedPass) c.accepted += 1;
            else c.rejected += 1;

            if (!p.defective && reportedPass) {
              p.outcome = "TP"; c.truePass += 1;            // good -> accepted
            } else if (p.defective && !reportedPass) {
              p.outcome = "TN"; c.trueReject += 1;          // defect -> rejected
            } else if (!p.defective && !reportedPass) {
              p.outcome = "FP"; c.falsePositive += 1;       // good -> rejected
            } else {
              p.outcome = "FN"; c.falseNegative += 1;       // defect -> accepted
            }

            // Recycling: every rejected part is routed to the recycler, where
            // a fraction of its resin mass (by material) is recovered.
            if (!reportedPass) {
              const m = p.material;
              const recovered = m.mass * m.recyclability;
              const rec = state.recycle;
              rec.rejectedMass += m.mass;
              rec.recovered += recovered;
              rec.byCode[m.code] = (rec.byCode[m.code] || 0) + recovered;
            }

            // Audio sensor: alert beep when a defective part is detected as it
            // passes the vision sensor; a soft blip for good parts.
            if (p.defective) {
              audio.defectBeep();
              state.alarmFlash = 26; // light up the audio sensor module
            } else {
              audio.passBlip();
            }

            updateStats();
            addLog(p);

            // Release the sensor for the next part.
            state.sensorBusyId = null;
          }
        }

        // At the sort point, start diverting toward the matching bin. A part
        // can only be sorted after it has actually been inspected.
        if (p.inspected && p.x >= SORT_X) {
          p.state = "sorting";
          p.vy = p.verdict === "accept" ? 3 : -3;
        }
      } else if (p.state === "sorting") {
        p.x += sp * 0.35;
        p.y += p.vy;
        p.vy *= 1.0;
        p.rotation += p.verdict === "accept" ? 0.12 : -0.12;

        const bin = p.verdict === "accept" ? ACCEPT_BIN : REJECT_BIN;
        const landed =
          p.verdict === "accept"
            ? p.y >= bin.y + bin.h - 18
            : p.y <= bin.y + 18;

        if (landed) {
          p.state = "done";
          const stack =
            p.verdict === "accept" ? state.settledAccept : state.settledReject;
          stack.push({ color: p.hex, shape: p.shape });
          if (stack.length > 18) stack.shift();
        }
      }
    }

    // Remove parts that have been sorted and parked.
    state.parts = state.parts.filter((p) => p.state !== "done");

    // --- Throughput overflow safeguard -------------------------------------
    // The line is rated for THROUGHPUT_LIMIT pieces. Once more than that have
    // been processed, auto-trip the (simulated) emergency stop so the user
    // doesn't have to catch it.
    if (state.counters.total > THROUGHPUT_LIMIT) {
      engageEstop("overflow");
      return; // line is now halted; skip the rest of this frame
    }

    // Drive the sorting robot: extend toward a part being diverted, otherwise
    // ease back to the home pose.
    const sorting = state.parts.find((p) => p.state === "sorting");
    const r = state.robot;
    if (sorting) {
      r.dir = sorting.verdict;
      r.target = 1;
      r.grip = 1;
    } else {
      r.target = 0;
      r.grip = 0;
    }
    r.reach += (r.target - r.reach) * 0.18; // ease toward target

    // Advance the scripted demo sequence.
    if (state.demo) updateDemo();
  }

  /* ------------------------------ Demo mode ------------------------------ */
  // A deterministic script: each entry is [materialCode, defectOrNull]. It
  // showcases every material and every outcome the robot can handle.
  const DEMO_SCRIPT = [
    ["PP",   null],        // good polypropylene  -> ACCEPT
    ["HDPE", "cracked"],   // cracked HDPE        -> REJECT
    ["PLA",  null],        // good PLA            -> ACCEPT
    ["PMMA", "malformed"], // malformed acrylic   -> REJECT
    ["PE",   null],        // good PE             -> ACCEPT
    ["HDPE", "color"],     // discolored HDPE     -> REJECT
    ["PMMA", null],        // good acrylic        -> ACCEPT
    ["PP",   "cracked"],   // cracked PP          -> REJECT
    ["PLA",  "color"],     // discolored PLA      -> REJECT
    ["PE",   null],        // good PE             -> ACCEPT
  ];

  function startDemo() {
    audio.unlock();             // prime audio from this user gesture
    reset();
    state.demo = true;
    // Force a clean, fully-accurate line so every verdict is deterministic.
    state.accuracy = 100;
    el.accuracy.value = 100;
    el.accuracyValue.textContent = "100%";
    setMode("normal");
    state.demoQueue = DEMO_SCRIPT.slice();
    state.demoTimer = 0;
    el.demoBtn.classList.add("active");
    el.demoBtn.innerHTML = '<span class="ico">■</span> Stop Demo';
    setStatus("running");
  }

  function stopDemo() {
    state.demo = false;
    state.demoQueue = [];
    el.demoBtn.classList.remove("active");
    el.demoBtn.innerHTML = '<span class="ico">▣</span> Demo';
  }

  function updateDemo() {
    // Release the next scripted part once the belt has room and enough spacing.
    if (state.demoQueue.length === 0) {
      // When the script is drained and all parts have cleared, end the demo.
      if (state.parts.length === 0) {
        stopDemo();
        setStatus("idle");
      }
      return;
    }
    state.demoTimer -= 1;
    if (state.demoTimer <= 0 && infeedClear()) {
      const [code, defect] = state.demoQueue.shift();
      state.parts.push(makePart(MATERIAL_BY_CODE[code], defect));
      state.demoTimer = 110; // spacing between scripted parts (frames)
    }
  }

  /* ------------------------------ Rendering ------------------------------ */
  function draw() {
    ctx.clearRect(0, 0, W, H);
    drawBackground();
    drawBins();
    drawBelt();
    drawSensor();
    drawAudioSensor();
    drawSortArm();
    for (const p of state.parts) drawPart(p);
    drawSettled();
  }

  /**
   * Audio sensor module mounted on the gantry next to the vision sensor. Its
   * grille lights up and emits "sound wave" arcs for a few frames whenever a
   * defect alarm beep fires. Dims out when audio is muted.
   */
  function drawAudioSensor() {
    const topY = 66;
    const x = SENSOR_X + 48;   // just right of the vision sensor
    const y = topY + 2;
    const active = state.alarmFlash > 0;
    const muted = !audio.isEnabled();

    // Housing.
    ctx.fillStyle = "#39465a";
    roundRect(x - 16, y, 32, 30, 5);
    ctx.fill();
    ctx.strokeStyle = active ? "#ff5f66" : "#5a6b82";
    ctx.lineWidth = 1.5;
    roundRect(x - 16, y, 32, 30, 5);
    ctx.stroke();

    // Speaker cone.
    ctx.fillStyle = muted ? "#2a3542" : active ? "#ff5f66" : "#263241";
    ctx.beginPath();
    ctx.arc(x, y + 15, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#1a222c";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Sound-wave arcs when the alarm is sounding.
    if (active && !muted) {
      const pulse = state.alarmFlash / 26;
      ctx.strokeStyle = `rgba(255,95,102,${pulse})`;
      ctx.lineWidth = 2;
      for (let k = 1; k <= 3; k++) {
        ctx.beginPath();
        ctx.arc(x, y + 15, 7 + k * 5, -Math.PI / 3, Math.PI / 3);
        ctx.stroke();
      }
    }

    // Mute slash.
    if (muted) {
      ctx.strokeStyle = "#ff5f66";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - 10, y + 6);
      ctx.lineTo(x + 10, y + 24);
      ctx.stroke();
    }

    // Label.
    ctx.fillStyle = "#cfe0ff";
    ctx.font = "700 8px 'Consolas', monospace";
    ctx.textAlign = "center";
    ctx.fillText("AUDIO", x, y - 4);
  }

  function drawBackground() {
    // Subtle floor grid (dark lines read on the light-blue background).
    ctx.save();
    ctx.strokeStyle = "rgba(40,70,95,0.12)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= W; x += 36) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    for (let y = 0; y <= H; y += 36) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.restore();

    // Station labels
    ctx.fillStyle = "rgba(30,55,80,0.55)";
    ctx.font = "600 12px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("INFEED", BELT.x + 30, BELT.y - 18);
    // INSPECTION sits just under the "H & K" brand label, above the sensor.
    ctx.fillText("INSPECTION", SENSOR_X, 38);
    ctx.fillText("SORTING", SORT_X + 10, BELT.y + 36);
  }

  function drawBelt() {
    const { x, y, width, height } = BELT;

    // Belt body
    ctx.fillStyle = "#2a3542";
    roundRect(x - 6, y - 6, width + 12, height + 12, 8);
    ctx.fill();

    // Belt surface — cream background.
    ctx.fillStyle = "#f3e9d2";
    roundRect(x, y, width, height, 6);
    ctx.fill();

    // Moving belt chevrons (darkened so they read on the light surface).
    ctx.save();
    ctx.beginPath();
    roundRect(x, y, width, height, 6);
    ctx.clip();
    ctx.strokeStyle = "rgba(90,70,40,0.25)";
    ctx.lineWidth = 3;
    for (let i = -40; i < width + 40; i += 40) {
      const px = x + i + state.beltOffset;
      ctx.beginPath();
      ctx.moveTo(px, y);
      ctx.lineTo(px + 14, y + height / 2);
      ctx.lineTo(px, y + height);
      ctx.stroke();
    }
    ctx.restore();

    // Rollers at each end
    drawRoller(x - 6, y + height / 2);
    drawRoller(x + width + 6, y + height / 2);
  }

  function drawRoller(cx, cy) {
    ctx.fillStyle = "#3a4656";
    ctx.beginPath();
    ctx.arc(cx, cy, 14, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.4)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(
      cx + Math.cos(state.beltOffset * 0.15) * 10,
      cy + Math.sin(state.beltOffset * 0.15) * 10
    );
    ctx.stroke();
  }

  function drawSensor() {
    const topY = 66;
    const beamBottom = BELT.y + BELT.height + 6;

    // Overhead gantry rail the scanner hangs from.
    ctx.fillStyle = "#2a3542";
    roundRect(SENSOR_X - 60, topY - 10, 120, 8, 3);
    ctx.fill();

    // Support post into the floor.
    ctx.fillStyle = "#2a3542";
    ctx.fillRect(SENSOR_X - 44, topY - 10, 7, beamBottom - topY + 10);

    // Is a part actively being scanned?
    const scanning = state.parts.some(
      (p) =>
        p.phase === "scanning" ||
        (p.scanFlash > 0 && Math.abs(p.x - SENSOR_X) < PART_RADIUS * 2)
    );

    // Vision sensor module.
    ctx.fillStyle = "#39465a";
    roundRect(SENSOR_X - 36, topY, 72, 34, 6);
    ctx.fill();
    ctx.strokeStyle = "#5a6b82";
    ctx.lineWidth = 1.5;
    roundRect(SENSOR_X - 36, topY, 72, 34, 6);
    ctx.stroke();

    // Lens.
    ctx.fillStyle = scanning ? "#ff5f66" : "#263241";
    ctx.beginPath();
    ctx.arc(SENSOR_X, topY + 17, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#1a222c";
    ctx.lineWidth = 2;
    ctx.stroke();

    // Status LED + label.
    ctx.fillStyle = scanning ? "#ffcb47" : "#3fd07f";
    ctx.beginPath();
    ctx.arc(SENSOR_X + 24, topY + 8, 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#1f4a6b";
    ctx.font = "700 9px 'Consolas', monospace";
    ctx.textAlign = "center";
    ctx.fillText("VISION", SENSOR_X, topY - 14);

    // Brand label above the vision sensor.
    ctx.fillStyle = "#e08a00";
    ctx.font = "800 13px 'Consolas', monospace";
    ctx.fillText("H & K", SENSOR_X, topY - 42);

    // Laser beam.
    const beamAlpha = scanning ? 0.55 : 0.16;
    ctx.save();
    const grad = ctx.createLinearGradient(0, topY + 34, 0, beamBottom);
    grad.addColorStop(0, `rgba(255,70,80,${beamAlpha})`);
    grad.addColorStop(1, `rgba(255,70,80,0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(SENSOR_X - 2, topY + 34, 4, beamBottom - topY - 34);
    ctx.strokeStyle = `rgba(255,70,80,${Math.min(1, beamAlpha + 0.4)})`;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(SENSOR_X, topY + 34);
    ctx.lineTo(SENSOR_X, beamBottom);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Articulated sorting robot. A two-segment arm mounted beside the belt at the
   * sort point. It stays in a home pose when idle and extends its gripper
   * toward whichever bin the current part is routed to (reach eased in update).
   */
  function drawSortArm() {
    const r = state.robot;
    const baseX = SORT_X;
    const baseY = BELT.y + BELT.height / 2;

    // Direction the arm serves: accept = swing down/right, reject = up/right.
    const dirSign = r.dir === "accept" ? 1 : -1;

    // Shoulder sits just above/below the belt; the arm swings through an arc
    // from a tucked home angle to an extended angle proportional to reach.
    const homeAngle = -Math.PI / 2 * dirSign * 0.15;
    const extAngle = dirSign * (Math.PI / 2) * 0.62;
    const shoulderAngle = homeAngle + (extAngle - homeAngle) * r.reach;
    const elbowAngle = dirSign * (0.4 + r.reach * 0.5);

    const seg1 = 42; // upper arm length
    const seg2 = 34; // forearm length

    // Base pedestal.
    ctx.fillStyle = "#39465a";
    roundRect(baseX - 16, baseY - 10, 32, 20, 5);
    ctx.fill();
    ctx.strokeStyle = "#5a6b82";
    ctx.lineWidth = 1.5;
    roundRect(baseX - 16, baseY - 10, 32, 20, 5);
    ctx.stroke();

    // Shoulder joint.
    const sx = baseX;
    const sy = baseY;
    // Elbow position.
    const ex = sx + Math.cos(shoulderAngle) * seg1;
    const ey = sy + Math.sin(shoulderAngle) * seg1;
    // Gripper position.
    const gAngle = shoulderAngle + elbowAngle;
    const gx = ex + Math.cos(gAngle) * seg2;
    const gy = ey + Math.sin(gAngle) * seg2;

    // Upper arm.
    ctx.strokeStyle = "#6f8099";
    ctx.lineWidth = 9;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(sx, sy);
    ctx.lineTo(ex, ey);
    ctx.stroke();

    // Forearm.
    ctx.strokeStyle = "#8697ad";
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(ex, ey);
    ctx.lineTo(gx, gy);
    ctx.stroke();

    // Joints.
    ctx.fillStyle = "#4f9cff";
    circle(sx, sy, 6);
    ctx.fillStyle = "#cdd9e8";
    circle(ex, ey, 5);

    // Gripper: two pincers that close (grip) when holding a part.
    const open = (1 - r.grip) * 6 + 3;
    ctx.strokeStyle = r.dir === "accept" ? "#3fd07f" : "#ff5f66";
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    const perp = gAngle + Math.PI / 2;
    for (const s of [-1, 1]) {
      const bx = gx + Math.cos(perp) * open * s;
      const by = gy + Math.sin(perp) * open * s;
      ctx.beginPath();
      ctx.moveTo(gx, gy);
      ctx.lineTo(bx, by);
      ctx.lineTo(bx + Math.cos(gAngle) * 8, by + Math.sin(gAngle) * 8);
      ctx.stroke();
    }

    ctx.lineCap = "butt";
  }

  function circle(cx, cy, rad) {
    ctx.beginPath();
    ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawBins() {
    drawBin(ACCEPT_BIN, "ACCEPTED", "#3fd07f");
    drawBin(REJECT_BIN, "REJECTED", "#ff5f66");

    // Chutes connecting the sort point to each bin.
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 6]);
    ctx.beginPath();
    ctx.moveTo(SORT_X, BELT.y + BELT.height / 2);
    ctx.lineTo(ACCEPT_BIN.x + ACCEPT_BIN.w / 2, ACCEPT_BIN.y);
    ctx.moveTo(SORT_X, BELT.y + BELT.height / 2);
    ctx.lineTo(REJECT_BIN.x + REJECT_BIN.w / 2, REJECT_BIN.y + REJECT_BIN.h);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawBin(bin, label, color) {
    ctx.fillStyle = "rgba(255,255,255,0.03)";
    roundRect(bin.x, bin.y, bin.w, bin.h, 8);
    ctx.fill();

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    roundRect(bin.x, bin.y, bin.w, bin.h, 8);
    ctx.stroke();

    ctx.fillStyle = color;
    ctx.font = "700 11px Segoe UI, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(label, bin.x + bin.w / 2, bin.y - 8);
  }

  function drawSettled() {
    drawStack(state.settledAccept, ACCEPT_BIN);
    drawStack(state.settledReject, REJECT_BIN);
  }

  function drawStack(stack, bin) {
    // Grid sized so the fullest stack stays inside the bin (120x84). With
    // 5 columns and 3 rows we show up to 15 of the most recent parts.
    const perRow = 5;
    const maxRows = 3;
    const size = 13;
    const gap = 4;
    const cell = size + gap;
    const capacity = perRow * maxRows;

    // Horizontally center the grid within the bin.
    const gridW = perRow * cell - gap;
    const startX = bin.x + (bin.w - gridW) / 2;
    const baseY = bin.y + bin.h - size - 8;

    // Only draw the most recent `capacity` items so nothing spills out.
    const visible = stack.slice(-capacity);
    visible.forEach((item, i) => {
      const row = Math.floor(i / perRow);
      const col = i % perRow;
      const px = startX + col * cell;
      const py = baseY - row * cell;
      ctx.fillStyle = item.color;
      ctx.globalAlpha = 0.9;
      roundRect(px, py, size, size, 3);
      ctx.fill();
      ctx.globalAlpha = 1;
    });
  }

  function drawPart(p) {
    ctx.save();
    ctx.translate(p.x, p.y);

    // Shadow
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.beginPath();
    ctx.ellipse(0, PART_RADIUS + 6, PART_RADIUS * 0.8, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.rotate(p.rotation);

    // Highlight ring right after inspection.
    if (p.scanFlash > 0) {
      ctx.strokeStyle =
        p.verdict === "accept" ? "#3fd07f" : "#ff5f66";
      ctx.lineWidth = 3;
      ctx.globalAlpha = p.scanFlash / 18;
      drawShapePath(p.shape, PART_RADIUS + 7, p.malformed);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Body
    ctx.fillStyle = p.hex;
    drawShapePath(p.shape, PART_RADIUS, p.malformed);
    ctx.fill();

    // Edge
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.lineWidth = 2;
    drawShapePath(p.shape, PART_RADIUS, p.malformed);
    ctx.stroke();

    // Gloss
    ctx.fillStyle = "rgba(255,255,255,0.25)";
    ctx.beginPath();
    ctx.ellipse(-6, -7, 5, 3, -0.6, 0, Math.PI * 2);
    ctx.fill();

    // Crack overlay for defective (cracked) parts.
    if (p.cracked) {
      ctx.strokeStyle = "rgba(10,10,10,0.75)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(-PART_RADIUS * 0.5, -PART_RADIUS * 0.4);
      ctx.lineTo(-2, 2);
      ctx.lineTo(-6, PART_RADIUS * 0.5);
      ctx.moveTo(-2, 2);
      ctx.lineTo(PART_RADIUS * 0.5, -2);
      ctx.stroke();
    }

    // Undo the spin so the material code label stays upright and readable.
    ctx.rotate(-p.rotation);
    ctx.fillStyle = "rgba(0,0,0,0.78)";
    ctx.font = "700 9px 'Consolas', 'Courier New', monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(p.material.code, 0, 0);
    ctx.textBaseline = "alphabetic";

    ctx.restore();
  }

  /** Draw a shape path centered at the current origin. `malformed` warps it. */
  function drawShapePath(shape, r, malformed) {
    const warp = malformed ? 0.45 : 0; // dent factor for bad parts
    ctx.beginPath();

    if (shape === "circle") {
      if (malformed) {
        // lumpy blob
        const steps = 16;
        for (let i = 0; i <= steps; i++) {
          const a = (i / steps) * Math.PI * 2;
          const rr = r * (1 + Math.sin(a * 3) * warp * 0.5);
          const x = Math.cos(a) * rr;
          const y = Math.sin(a) * rr;
          i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
        }
      } else {
        ctx.arc(0, 0, r, 0, Math.PI * 2);
      }
    } else if (shape === "square") {
      const s = r * 0.9;
      if (malformed) {
        ctx.moveTo(-s, -s);
        ctx.lineTo(s * (1 - warp), -s);
        ctx.lineTo(s, s);
        ctx.lineTo(-s * (1 - warp * 0.5), s * (1 - warp));
      } else {
        ctx.rect(-s, -s, s * 2, s * 2);
      }
      ctx.closePath();
    } else if (shape === "triangle") {
      const s = r * 1.1;
      ctx.moveTo(0, -s);
      ctx.lineTo(s * (1 - warp), s * 0.8);
      ctx.lineTo(-s, s * 0.8 * (1 - warp * 0.6));
      ctx.closePath();
    } else if (shape === "hexagon" || shape === "pentagon") {
      const steps = shape === "hexagon" ? 6 : 5;
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2 - Math.PI / 2;
        const rr = malformed && i % 2 === 0 ? r * (1 - warp) : r;
        const x = Math.cos(a) * rr;
        const y = Math.sin(a) * rr;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.closePath();
    }
  }

  /* ------------------------------ Utilities ------------------------------ */
  function roundRect(x, y, w, h, r) {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }

  /* ------------------------------ Main loop ------------------------------ */
  function loop() {
    update();
    draw();
    // Keep the propagation rate live while running (it changes with run time,
    // not just when a part is inspected).
    if (state.status === "running") updatePropagationRate();
    requestAnimationFrame(loop);
  }

  // Initialize
  renderMaterialLegend();
  setStatus("idle");
  updateStats();
  el.speed.value = state.speed;
  el.accuracy.value = state.accuracy;
  el.accuracyValue.textContent = state.accuracy + "%";
  el.defectRate.value = state.defectRate;
  el.defectRateValue.textContent = state.defectRate + "%";
  setMode(state.mode);
  loop();
})();
