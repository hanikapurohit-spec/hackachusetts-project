
# My Hackachusetts Project

## Project Demo Video

Watch our project demonstration here:

https://youtu.be/gxUrPGBo5jo 

# KiroBot — Automated Inspection & Sorting Dashboard

A 2D factory-floor simulation built with **plain HTML, CSS, and JavaScript**.
No backend, no build step, no paid APIs, no hardware. It runs entirely in your
browser.

KiroBot animates a conveyor belt that carries plastic parts of different resin
types past a **vision inspection sensor**. Each part is scanned, judged
pass/defect, and handled by an **articulated sorting robot** that routes it into
an ACCEPTED or REJECTED bin. The whole thing is styled as an industrial control
room, with live counters tracking everything in real time.

## Features

- **Industrial control-room aesthetic** — steel HMI panels, monospace
  readouts, hazard-stripe accents, status LEDs, and CRT-style scanlines.
- **Plastic material types** — parts are one of five resins, each with its own
  color and shape and labeled with its code:

  | Code | Material | Shape |
  | ---- | -------- | ----- |
  | HDPE | High-Density Polyethylene | hexagon |
  | PLA  | Polylactic Acid | triangle |
  | PMMA | Acrylic | square |
  | PE   | Polyethylene | circle |
  | PP   | Polypropylene | pentagon |

- **Conveyor belt** with animated rollers and moving tread.
- **Visible vision sensor** — an overhead scanner module with a lens that lights
  up and a laser beam that flashes as each part is scanned.
- **Visible sorting robot** — an articulated two-segment arm with a gripper that
  reaches toward the correct bin for each part and closes its pincers as it
  handles the part.
- **Audio defect sensor** — a speaker module mounted beside the vision sensor.
  It sounds an alert beep (and flashes sound-wave arcs) the moment a defective
  part is detected passing the sensor; good parts get a soft blip. Sound is
  synthesized in-browser with the Web Audio API — no sound files.
- **Controls** — `Start`, `Pause` / `Resume`, `Reset`, `Demo`, an `Audio`
  mute toggle, a belt-speed slider, and an **Emergency Stop** (see below).
- **Sensor controls** — a sensor-accuracy slider and a Normal / High-Speed
  inspection-mode toggle.
- **Live metrics** — Total Processed, Accepted, Rejected, Defect Rate, plus the
  simulation-quality panel (false positives, defects passed, escape rate) and a
  waste-reduction indicator.
- **Inspection log** — a running feed of each part's material, verdict, reason,
  and any sensor misread.
- **Factory status indicator** — Idle / Running / Paused.

## Emergency stop (software simulation)

> ⚠ **This is a software simulation, not a safety system.** The emergency stop
> affects only the on-screen virtual line. It is **not** a functional-safety
> device and must never be relied on to protect people or real equipment.

The red **E-STOP** mushroom button latches an emergency stop:

- All simulated machine motion halts instantly — belt, part feed, the sorting
  robot, and the demo sequence all freeze in place.
- A red overlay banner appears and the status indicator shows **E-STOP**.
- Normal operation is **locked out**: Start, Pause, Reset, and Demo are
  disabled while the E-stop is latched, so the line cannot be run.
- An alarm tone sounds (if audio is enabled).

The line stays stopped until you press **Clear & Reset**, which releases the
latch and returns the line to a fresh, idle state — matching the real-world
rule that an e-stop must be cleared *and* the system reset before operation can
resume. You can also press the **Spacebar** as a quick panic key to engage the
stop.

### Automatic overflow stop + auto-recovery (throughput cap)

The line is rated for a batch of **45 material pieces**. The "Processed / Cap"
metric shows the running count against this limit. As soon as **more than 45**
pieces have been processed, the sim treats it as an overflow and engages the
E-stop **automatically** — no user action needed. The button and overlay turn
amber and read `AUTO E-STOP — OVERFLOW`.

After an overflow stop the line **recovers itself**: it pauses for about two
seconds (showing the alert), then automatically clears, resets the counters,
and restarts — so the line cycles on its own, hitting the cap, stopping, and
resuming repeatedly. A **manual** E-stop does *not* auto-recover; it waits for
you to press **Clear & Reset**. (Still a software simulation, not a safety
function.)

### Recycling

Below the waste-reduction indicator, the **Recycling** component tracks what
happens to rejected parts: each one is routed to the recycler, which recovers a
fraction of its resin mass depending on the material (PP, PE, and HDPE recycle
well; PLA and PMMA less so). It shows the total grams recovered, the overall
recovery efficiency (recovered ÷ rejected mass) as a color-banded bar, and a
per-material breakdown of how many grams of each resin were reclaimed.

### Propagation rate

The **Propagation Rate** readout shows how fast material propagates through the
line, derived from throughput: pieces processed per minute over actual running
time (`pcs/min`). Its bar fills toward the 45-piece cap and shifts green →
amber → red as the line approaches the auto-stop limit, giving an at-a-glance
sense of both speed and how close the batch is to tripping.

## Demo mode

Click **Demo** to run a fixed, scripted sequence of ten parts that showcases
every material type and every outcome — good parts the robot accepts, and
cracked, discolored, or malformed parts it rejects. Demo mode forces 100% sensor
accuracy and Normal speed so each verdict is deterministic and easy to follow,
then returns the line to Idle when the sequence finishes. Click it again (or
press Start / Reset) to leave demo mode.

## Inspection logic (simulated sensor)

When a part reaches the inspection station it dwells under the scan beam while
a **simulated sensor** runs three independent QC checks:

| Check | Fails when… |
| ----- | ----------- |
| Color | the resin is discolored / contaminated (rendered gray) |
| Body  | the part has a cracked body |
| Shape | the part geometry is malformed / out of tolerance |

The sensor assigns a single result:

- **PASS** — every check is within spec → routed to the **ACCEPTED** bin.
- **FAIL** — one or more checks failed → routed to the **REJECTED** bin.

All dashboard counters (Total, Accepted/PASS, Rejected/FAIL, Defect Rate)
update immediately the instant each inspection completes. Only one part is
scanned at a time, each part is inspected exactly once, and parts maintain a
safe gap so they never overlap on the belt. Roughly 1 in 4 parts is seeded
with a defect, so you'll see a realistic PASS/FAIL mix.

### Sensor controls

- **Sensor Accuracy (50%–100%)** — sets how reliably the sensor reports the
  true condition of a part. At 100% it never errs. As you lower it, the sensor
  occasionally **misreads** a part and flips its verdict (a defect slips
  through as PASS, or a good part is falsely rejected). Misreads are flagged
  with a `⚠ misread` badge in the inspection log, so you can see the accuracy
  setting at work.
- **Inspection Mode** — choose how the line scans:
  - **Normal** — a longer scan dwell for the most reliable reading, at a
    steady belt speed.
  - **High-Speed** — runs the line at a realistic factory pace: the belt moves
    ~1.6× faster, parts arrive more frequently, and the scan dwell is much
    shorter. Throughput rises noticeably (brisk, not frantic) at the cost of a
    small accuracy penalty — the real trade-off between speed and reliability.

Both controls take effect immediately and apply to every subsequent
inspection, even while the line is running.

### Manufacturing simulation

- **Incoming Defect Rate (0%–100%)** — sets the share of parts that are
  *manufactured* defective as they enter the conveyor. This is the ground-truth
  condition of each part, independent of what the sensor later reports.

The dashboard tracks the outcome of every inspection against ground truth:

| Metric | Meaning |
| ------ | ------- |
| Total Processed | Every part that has completed inspection |
| Material Rejected | All parts routed to the reject bin |
| False Positives | **Good** parts the sensor wrongly rejected (avoidable waste) |
| Defects Passed | **Defective** parts the sensor wrongly accepted (false negatives / escaped defects) |
| Escape Rate | Share of all defective parts that slipped through as PASS |

**Waste Reduction indicator** — "waste" is good material that gets thrown
away, i.e. false positives. The indicator scores the share of processed parts
that were *not* wasted this way and bands it green / amber / red:

- **≥ 95%** — good: very little good material is being discarded.
- **85%–95%** — ok.
- **< 85%** — poor: the sensor is rejecting too many good parts.

Try it: push the incoming defect rate up and the sensor accuracy down, and
watch false positives, escaped defects, and the waste reduction score respond
in real time.

## Running it locally

KiroBot is just static files, so you have two easy options.

### Option 1 — Open directly (simplest)

Double-click **`index.html`**, or from a terminal in this folder:

**Windows (PowerShell):**
```powershell
Start-Process index.html
```

**macOS:**
```bash
open index.html
```

**Linux:**
```bash
xdg-open index.html
```

### Option 2 — Serve over a local web server (optional)

Any static server works. For example, with Python (already on most systems):

```bash
# from inside the KiroBot folder
python -m http.server 8000
```

Then visit <http://localhost:8000> in your browser.

> No Node.js, npm, or any dependency install is required for either option.

## How to use

1. Click **Start** to spin up the line.
2. Watch parts get scanned at the sensor and sorted into bins.
3. Use the **Belt Speed** slider to speed up or slow down throughput.
4. Click **Pause** to freeze the line (button becomes **Resume**).
5. Click **Reset** to clear all parts, counters, and the log.

## File structure

```
KiroBot/
├── index.html    # Dashboard markup
├── styles.css    # Theme, layout, and component styling
├── script.js     # Simulation engine, rendering, and controls
└── README.md     # This file
```

## Tech notes

- The factory floor is drawn on an **HTML5 Canvas** for smooth animation, with
  high-DPI (retina) support.
- The dashboard chrome (header, controls, metrics, log) is standard DOM styled
  with CSS, so it stays crisp and accessible.
- Everything is in one self-contained IIFE in `script.js` — no globals leak.
