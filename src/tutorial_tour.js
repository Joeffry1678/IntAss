// tutorial_tour.js
// IntAss overlay tour (self-contained). Drop this file next to renderer.html and add:
// <script src="./tutorial_tour.js"></script>

(() => {
  const { ipcRenderer } = (() => {
    try { return require("electron").ipcRenderer; } catch { return {}; }
  })();

  const q = (sel) => document.querySelector(sel);


  const isVisible = (el) => !!(el && (el.offsetParent !== null || el.getClientRects?.().length));
  const txt = (sel) => (q(sel)?.textContent || "").trim();

  function isScriptLoaded() {
    // Use the status pill text as the “source of truth”
    // (your UI commonly shows "NO SCRIPT LOADED" / "LOCKED" / "UNLOCKED" etc.)
    const pill = txt("#script-status-pill").toUpperCase();
    if (!pill) return false;
    if (pill.includes("NO SCRIPT")) return false;
    if (pill.includes("NOT LOADED")) return false;
    return true;
  }

  function isScriptEditorOpen() {
    // Some builds use #script-editor, others use .script-editor
    const ed = q("#script-editor") || q(".script-editor");
    return isVisible(ed);
  }


  // ---------- Styles (injected) ----------
  const STYLE = `
  :root{
    --tour-z: 2147483646;
    --tour-bg: transparent;
    --tour-card: rgba(20,20,20,0.96);
    --tour-border: rgba(255,255,255,0.12);
    --tour-accent: rgba(0,120,212,0.95);
  }

  #intass-tour-fab{
    position: fixed;
    right: 16px;
    top: 54px; /* under titlebar */
    width: 42px;
    height: 42px;
    border-radius: 14px;
    border: 1px solid rgba(255,255,255,0.14);
    background: rgba(255,255,255,0.07);
    backdrop-filter: blur(16px);
    -webkit-backdrop-filter: blur(16px);
    box-shadow: 0 14px 34px rgba(0,0,0,0.35);
    display:flex;
    align-items:center;
    justify-content:center;
    cursor:pointer;
    z-index: var(--tour-z);
    -webkit-app-region: no-drag;
    transition: transform 120ms ease, background 120ms ease;
  }
  #intass-tour-fab:hover{ background: rgba(255,255,255,0.12); transform: translateY(-1px); }
  #intass-tour-fab:active{ transform: scale(0.98); }

  #intass-tour-fab img{
    width: 26px;
    height: 26px;
    border-radius: 10px;
    object-fit: cover;
    opacity: 0.92;
    pointer-events:none;
    user-select:none;
  }

  #intass-tour-picker,
  #intass-tour-overlay{
    position: fixed;
    inset: 0;
    z-index: var(--tour-z);
    display:none;
    -webkit-app-region: no-drag;
  }
  #intass-tour-picker.show,
  #intass-tour-overlay.show{ display:block; }

  /* Backdrop */
  .tour-backdrop{
    position:absolute;
    inset:0;
    background: var(--tour-bg);
    backdrop-filter: none !important;
    -webkit-backdrop-filter: none !important;
  }


  /* Picker modal */
  .tour-picker-card{
    position:absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: min(560px, calc(100vw - 30px));
    border-radius: 18px;
    background: var(--tour-card);
    border: 1px solid var(--tour-border);
    box-shadow: 0 20px 55px rgba(0,0,0,0.60);
    padding: 16px;
    color: rgba(255,255,255,0.92);
    font-family: Segoe UI, system-ui, sans-serif;
  }
  .tour-picker-top{
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:10px;
    margin-bottom: 10px;
  }
  .tour-picker-title{
    font-size: 14px;
    font-weight: 900;
    letter-spacing: 0.3px;
  }
  .tour-x{
    border:1px solid rgba(255,255,255,0.14);
    background: rgba(255,255,255,0.06);
    color: rgba(255,255,255,0.9);
    border-radius: 12px;
    padding: 8px 10px;
    cursor:pointer;
    font-weight: 800;
  }
  .tour-grid{
    display:grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
  }
  @media (max-width: 520px){
    .tour-grid{ grid-template-columns: 1fr; }
  }
  .tour-tile{
    border: 1px solid rgba(255,255,255,0.12);
    background: rgba(255,255,255,0.06);
    border-radius: 16px;
    padding: 12px;
    cursor:pointer;
    transition: background 120ms ease, transform 120ms ease, border 120ms ease;
  }
  .tour-tile:hover{
    background: rgba(255,255,255,0.10);
    border-color: rgba(0,120,212,0.55);
    transform: translateY(-1px);
  }
  .tour-tile h4{
    margin:0 0 6px 0;
    font-size: 12px;
    font-weight: 900;
    letter-spacing: 0.6px;
    text-transform: uppercase;
    color: rgba(180,220,255,0.95);
  }
  .tour-tile p{
    margin:0;
    font-size: 12px;
    line-height: 1.45;
    color: rgba(255,255,255,0.72);
  }

  /* Step overlay */
  .tour-highlight{
    position:absolute;
    border-radius: 14px;
    box-shadow: 0 0 0 9999px var(--tour-bg);
    border: 2px solid rgba(0,120,212,0.95);
    pointer-events:none;
  }

  .tour-card{
    position:absolute;
    width: min(420px, calc(100vw - 30px));
    border-radius: 18px;
    background: var(--tour-card);
    border: 1px solid var(--tour-border);
    box-shadow: 0 20px 55px rgba(0,0,0,0.60);
    padding: 14px;
    color: rgba(255,255,255,0.92);
    font-family: Segoe UI, system-ui, sans-serif;
  }
  .tour-card .kicker{
    font-size: 10px;
    letter-spacing: 1.6px;
    text-transform: uppercase;
    color: rgba(255,255,255,0.58);
    margin-bottom: 6px;
  }
  .tour-card .t{
    font-size: 14px;
    font-weight: 900;
    margin: 0 0 8px 0;
  }
  .tour-card .b{
    font-size: 12.5px;
    line-height: 1.5;
    color: rgba(255,255,255,0.78);
    margin: 0 0 12px 0;
    white-space: pre-wrap;
  }
  .tour-actions{
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:10px;
  }
  .tour-actions .left,
  .tour-actions .right{
    display:flex;
    gap:8px;
    align-items:center;
  }
  .tour-btn{
    border: 1px solid rgba(255,255,255,0.14);
    background: rgba(255,255,255,0.06);
    color: rgba(255,255,255,0.92);
    border-radius: 12px;
    padding: 8px 10px;
    cursor:pointer;
    font-weight: 800;
    font-size: 12px;
  }
  .tour-btn.primary{
    background: var(--tour-accent);
    border-color: rgba(0,120,212,0.65);
  }
  .tour-btn:disabled{
    opacity: 0.5;
    cursor:not-allowed;
  }
  .tour-progress{
    font-size: 11px;
    color: rgba(255,255,255,0.55);
    font-weight: 800;
  }
  `;

  function injectStyle() {
    if (q("#intass-tour-style")) return;
    const st = document.createElement("style");
    st.id = "intass-tour-style";
    st.textContent = STYLE;
    document.head.appendChild(st);
  }

  function bindTitlebarIcon() {
    const icon = q("#appIcon");
    if (!icon) return;

    // Make it clickable
    icon.style.cursor = "pointer";
    icon.style.webkitAppRegion = "no-drag"; // important for draggable titlebar

    icon.title = "Open IntAss Tutorial";

    icon.addEventListener("click", (e) => {
      e.stopPropagation();
      TourPicker.open();
    });
  }


  // ---------- UI creation ----------
  function el(tag, attrs = {}, children = []) {
    const n = document.createElement(tag);

    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") {
        n.className = v;
      } else if (k === "html") {
        n.innerHTML = v;
      } else if (k.startsWith("on") && typeof v === "function") {
        n.addEventListener(k.slice(2), v);
      } else if (typeof v === "boolean") {
        // ✅ boolean attributes: present = true, absent = false
        if (v) n.setAttribute(k, "");
        // if false, do nothing (don’t set the attr)
      } else if (v != null) {
        n.setAttribute(k, String(v));
      }
    }

    for (const c of [].concat(children)) {
      if (c == null) continue;
      n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
    }

    return n;
  }


  async function resolveLogoUrl() {
    // Prefer packaged assets via IPC (main.js supports assets:getUrl). If unavailable, fallback.
    try {
      if (ipcRenderer?.invoke) {
        let r = await ipcRenderer.invoke("assets:getUrl", "intass.png");
        if (r?.ok && r?.url) return r.url;
        r = await ipcRenderer.invoke("assets:getUrl", "intass.jpg");
        if (r?.ok && r?.url) return r.url;
      }
    } catch {}
    // fallback: use app icon if present
    const appIcon = q("#appIcon");
    if (appIcon?.src) return appIcon.src;
    return "";
  }



    async function loadTutorialScript() {
      await forceScriptMode(true);
      await sleep(200);

      const template = {
        meta: {
          schema: "intass_script_v1",
          name: "Tutorial Script",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        nodes: {
          start: {
            say: "Welcome to the tutorial. Would you like billing or support?",
            listen_for: ["billing", "support"],
            routes: {
              billing: "billing_node",
              support: "support_node"
            }
          },
          billing_node: {
            say: "You selected billing.",
            listen_for: [],
            routes: {}
          },
          support_node: {
            say: "You selected support.",
            listen_for: [],
            routes: {}
          }
        }
      };

        // Directly inject into your editor state
        if (window.setCurrentScriptDirect) {
          window.setCurrentScriptDirect(template);
        }


        // Force editor visible (tutorial-only mode)
        await sleep(200);

        const editor =
          q("#script-editor") ||
          q(".script-editor");

        if (editor) {
          editor.style.display = "flex";
          editor.style.visibility = "visible";
          editor.style.opacity = "1";
        }

    }


  // ---------- Tours ----------
  const Tours = {

    support: {
      title: "Support Mode Basics",
      desc: "Start/stop capture, Primary/AI panes, and where answers show up.",
      steps: [
        { sel: "#capture-btn", title: "Start / Stop listening", body: "Click Start to begin voice capture (or press Space). Click again to stop." },
        { sel: "#ctx-toggle", title: "Primary Context", body: "Primary shows your context + knowledge snippets. Keep this ON for better answers." },
        { sel: "#ai-toggle", title: "AI Answer", body: "AI Answer shows the assistant response. If you want pure context only, toggle this OFF." },
        { sel: "#output", title: "Transcription History", body: "Your live transcription and history logs show here. Click items to select/copy/edit (when unlocked)." },
      ]
    },
    resources: {
      title: "Resources & Indexing",
      desc: "Load your local PDFs/DOCX/PPTX resources and re-index.",
      steps: [
        { 
          sel: "#resources-btn",
          title: "Resources Folder",
          body:
            "Pick a folder of PDFs/DOCX/PPTX. (ALWAYS PICK A RESOURCE FOLDER EVERYTIME YOU OPEN THE APP).\n\n" +
            "Proper Documentation Format: <a href='#' id='open-resources-guide' style='color:#6cb8ff;font-weight:700;'>Open Resources Guide</a>"
        },
        { sel: "#reload-btn", title: "Reload", body: "Reload refreshes the renderer UI (ALWAYS CLICK THIS IF YOU HAVE ANY CHANGES OR PICK A NEW RESOURCE FOLDER)." },
        { sel: "#rescan-btn", title: "Rescan Audio", body: "If your mic disappears, rescan audio devices." },
      ]
    },
    privacy: {
      title: "Privacy & Window Opacity",
      desc: "Capture protection + window transparency.",
      steps: [
        { sel: "#privacy-toggle", title: "Privacy Toggle", body: "Turns on screen-capture protection (where supported). Keep it ON for sensitive screens." },
        { sel: "#opacity-slider", title: "Opacity Slider", body: "Adjust window opacity to see behind the app while working." },
        { sel: "#machine-id-pill", title: "Machine ID Pill", body: "Click to copy Machine ID (useful for licensing / support)." },
      ]
    },
    script: {
      title: "Script Mode – Basic Guide",
      desc: "Learn how to open/create a script and use Unlock/Edit properly.",
      steps: [

        {
          sel: "#mode-btn",
          title: "Step 1 – Switch to Script Mode",
          body: "Click here to enter Script Mode.\n\nScript tools only appear in Script mode.",
          ensure: () => forceScriptMode(true)
        },

        {
          sel: "#script-tools-inline",
          title: "Step 2 – Script Toolbar",
          body: "This toolbar appears only in Script Mode.\n\nBefore using Unlock/Edit, you MUST either:\n• Create a new script\n• OR Open an existing script",
          ensure: () => forceScriptMode(true)
        },

        {
          sel: "#script-new2-btn",
          title: "Option A – Create New Script",
          body: "Click New to create a script.\n\nYou will be asked to set a 4-digit PIN.\n\nThis PIN is required later to unlock editing.",
          ensure: () => forceScriptMode(true)
        },

        {
          sel: "#script-open2-btn",
          title: "Option B – Open Existing Script",
          body: "Click Open to load a script JSON file.\n\nIf the script is locked, you will need its PIN to edit.",
          ensure: () => forceScriptMode(true)
        },

        {
          sel: "#script-status-pill",
          title: "Script Status Indicator",
          body: "This pill shows whether the script is:\n\n• LOCKED (read-only)\n• UNLOCKED (editable)\n\nYou cannot edit while locked.",
          ensure: () => forceScriptMode(true)
        },

        {
          sel: "#script-unlock-btn",
          title: "Unlock / Edit Button",
          body: "Click Unlock/Edit and enter the 4-digit PIN.\n\nOnce unlocked:\n• You can add nodes\n• Edit prompts\n• Change routing\n\nClick Lock again to protect the script.",
          ensure: () => forceScriptMode(true)
        },

        {
          sel: "#script-editor",
          title: "Editing Mode",
          body: "When unlocked, editing controls become visible.\n\nIf nothing is editable, check if the script is still LOCKED.",
          ensure: () => forceScriptMode(true)
        },

      ]
    },

    script_editor: {
  title: "Script Editor – Add Nodes & Keyword Listeners",
  desc: "Add nodes, set listen_for keywords, create routes, and save — inside Edit Mode (gated).",
  steps: [
    {
      sel: "#mode-btn",
      title: "Switch to Script Mode",
      body: "This tutorial is for Script Edit Mode.\n\nFirst, switch to Script Mode.",
      ensure: () => forceScriptMode(true)
    },

    {
      sel: "#script-tools-inline",
      title: "Create or Open a script FIRST",
      body:
        "You must **Create (New)** or **Open** a script before Edit Mode exists.\n\n" +
        "When a script is loaded, the Status pill will change from “NO SCRIPT …” to LOCKED/UNLOCKED.",
      ensure: () => forceScriptMode(true),
    },

    {
      sel: "#script-unlock-btn",
      title: "Unlock/Edit to enter Edit Mode",
      body:
        "Now click **Unlock/Edit** and enter the 4-digit PIN.\n\n" +
        "When the editor opens, you will see the Script Editor panel.",
      ensure: () => forceScriptMode(true),
    },

    // --------- EDIT MODE STEPS (only proceed once editor is open) ---------

    {
      sel: "#script-editor",
      title: "You are now in Edit Mode",
      body:
        "Great — this is the Script Editor.\n\n" +
        "Next we’ll add nodes, listening keywords (listen_for), and routes.",
      ensure: () => forceScriptMode(true)
    },

    {
      sel: "#se-add-node",
      title: "Add a Node",
      body:
        "Click **+ Add Node** to create a new node.\n\n" +
        "After creating it, select the node from the node list to edit its content.",
      ensure: () => forceScriptMode(true)
    },

    {
      sel: "#se-node-list",
      title: "Select the node you want to edit",
      body:
        "Click a node in the list.\n\n" +
        "The right panel updates to show that node’s Say / Listen / Routes fields.",
      ensure: () => forceScriptMode(true)
    },

    {
      sel: "#se-say",
      title: "Set the node prompt (say)",
      body:
        "Type what the assistant will say at this node.\n\n" +
        "Example:\n" +
        "“Would you like billing or support?”",
      ensure: () => forceScriptMode(true)
    },

    {
      sel: "#se-listen",
      title: "Add keyword listeners (listen_for)",
      body:
        "Add the words/phrases the user might say.\n\n" +
        "Use comma-separated keywords.\n" +
        "Example:\n" +
        "billing, support, agent, yes, no\n\n" +
        "These keywords are what routing should use.",
      ensure: () => forceScriptMode(true)
    },

    {
      sel: "#se-routes",
      title: "Routes map keyword → next node",
      body:
        "Routes decide where the script goes next.\n\n" +
        "Each route row links:\n" +
        "• a keyword (must be in listen_for)\n" +
        "→ a target node ID.",
      ensure: () => forceScriptMode(true)
    },

    {
      sel: "#se-add-route",
      title: "Add a route row",
      body:
        "Click **Add Route**.\n\n" +
        "1) Enter the keyword (must match listen_for)\n" +
        "2) Choose the next node from the dropdown",
      ensure: () => forceScriptMode(true)
    },

    {
      sel: "#se-save",
      title: "Save your changes",
      body:
        "Click **Save** to write changes to the script file.\n\n" +
        "If something is invalid (missing target node, etc.), you’ll see an error instead.",
      ensure: () => forceScriptMode(true)
    }
  ]
},

    ai_key: {
      title: "AI Setup – Add API Key (.env)",
      desc: "Where to paste your Gemini API key so AI works.",
      steps: [
        {
          sel: null, // no highlight, centered card
          title: "Add your Gemini API key",
          body:
            "To enable AI on this PC, paste your API key into the .env file located here:\n\n" +
            "📁 Installed app location:\n" +
            "resources/engine/.env\n\n" +
            "Edit with notepad the .env file\n\n" +
            "Replace the YOUR_KEY_HERE with your own API from google studio:\n" +
            "GEMINI_API_KEY=YOUR_KEY_HERE\n\n" +
            "Then restart IntAss."
        }
      ]
    },




  };

  async function forceScriptMode(wantScript) {
    const body = document.body;
    const isScript = body.classList.contains("mode-script");
    if (wantScript && !isScript) {
      // click the mode button to toggle
      const b = q("#mode-btn");
      if (b) b.click();
      await sleep(160);
    }
    if (!wantScript && isScript) {
      const b = q("#mode-btn");
      if (b) b.click();
      await sleep(160);
    }
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ---------- Picker ----------
  const TourPicker = {
    open() {
      injectStyle();
      this.ensure();
      q("#intass-tour-picker").classList.add("show");
    },
    close() {
      q("#intass-tour-picker")?.classList.remove("show");
    },
    ensure() {
      if (q("#intass-tour-picker")) return;

      const root = el("div", { id: "intass-tour-picker" }, [
        el("div", { class: "tour-backdrop" }),
        el("div", { class: "tour-picker-card" }, [
          el("div", { class: "tour-picker-top" }, [
            el("div", { class: "tour-picker-title" }, ["IntAss Tutorial"]),
            el("button", { class: "tour-x", onclick: () => this.close() }, ["Close"]),
          ]),
          el("div", { class: "tour-grid", id: "tour-grid" }),
        ])
      ]);

      document.body.appendChild(root);

      const grid = q("#tour-grid");
      for (const [key, t] of Object.entries(Tours)) {
        const tile = el("div", { class: "tour-tile" }, [
          el("h4", {}, [t.title]),
          el("p", {}, [t.desc]),
        ]);
        tile.addEventListener("click", () => {
          this.close();
          TourRunner.start(key);
        });
        grid.appendChild(tile);
      }

      // click backdrop to close
      root.querySelector(".tour-backdrop").addEventListener("click", () => this.close());
    }
  };

  // ---------- Runner ----------
  const TourRunner = {

    key: null,
    idx: 0,
    steps: [],
    async open(key) {
      injectStyle();
      this.ensureOverlay();
      this.key = key;
      this.idx = 0;
      this.steps = (Tours[key]?.steps || []).slice();
      q("#intass-tour-overlay").classList.add("show");
      if (key === "script_editor") {
        await loadTutorialScript();
      }
      this.render();
    },
    close() {
      q("#intass-tour-overlay")?.classList.remove("show");
      // return to Support mode after Script tour ends
      if (this.key === "script" || this.key === "script_editor") forceScriptMode(false);
      this.key = null;
      this.steps = [];
      this.idx = 0;
    },
    next() {
      if (this.idx < this.steps.length - 1) this.idx++;
      else return this.close();
      this.render();
    },
    back() {
      if (this.idx > 0) this.idx--;
      this.render();
    },
    ensureOverlay() {
      if (q("#intass-tour-overlay")) return;

      const root = el("div", { id: "intass-tour-overlay" }, [
        el("div", { class: "tour-backdrop" }),
        el("div", { class: "tour-highlight", id: "tour-highlight" }),
        el("div", { class: "tour-card", id: "tour-card" }),
      ]);
      document.body.appendChild(root);

      // ESC closes
      window.addEventListener("keydown", (e) => {
        if (!q("#intass-tour-overlay")?.classList.contains("show")) return;
        if (e.key === "Escape") this.close();
      });
    },
    async render() {
      const t = Tours[this.key];
      const step = this.steps[this.idx];

      // run ensure hook (e.g., force Script mode)
      try { if (step?.ensure) await step.ensure(); } catch {}

      // get target
      let target = step?.sel ? q(step.sel) : null;

      // ✅ If the selector hits the hidden checkbox input, highlight the visible switch instead
      if (target) {
        // if it's the checkbox itself
        if (target.matches?.('input[type="checkbox"]')) {
          target =
            target.closest?.(".ai-switch") ||
            target.parentElement?.closest?.(".ai-switch") ||
            target.parentElement ||
            target;
        }

  // if it's a wrapper/pill, find the actual switch inside
  const innerSwitch = target.querySelector?.(".ai-switch");
  if (innerSwitch) target = innerSwitch;

  // if it lands on the switch, prefer the visible slider span
  const slider = target.querySelector?.(".slider");
  if (slider) target = slider;
}


      // If missing, show centered card without highlight
      if (!target) {
        this.positionCentered(step, t);
        return;
      }

      // make sure visible
      try { target.scrollIntoView({ block: "center", behavior: "smooth" }); } catch {}
      await sleep(120);

      const r = target.getBoundingClientRect();
      const hi = q("#tour-highlight");

      // tighter for switches, normal for everything else
      const isSwitch = target.classList?.contains("ai-switch") ||
                       target.classList?.contains("slider") ||
                       target.closest?.(".ai-switch");

      const pad = isSwitch ? 3 : 8;

      // pill highlight for switches
      hi.style.borderRadius = isSwitch ? "999px" : "14px";

      hi.style.left = Math.max(10, r.left - pad) + "px";
      hi.style.top = Math.max(10, r.top - pad) + "px";
      hi.style.width = Math.min(window.innerWidth - 20, r.width + pad * 2) + "px";
      hi.style.height = Math.min(window.innerHeight - 20, r.height + pad * 2) + "px";

      this.positionCardNear(r, step, t);
    },
    positionCentered(step, tourMeta) {
      const hi = q("#tour-highlight");
      hi.style.left = "-9999px";
      hi.style.top = "-9999px";
      hi.style.width = "1px";
      hi.style.height = "1px";

      const card = q("#tour-card");
      card.style.left = "50%";
      card.style.top = "50%";
      card.style.transform = "translate(-50%, -50%)";
      card.innerHTML = "";
      card.appendChild(this.cardContent(step, tourMeta));
    },
    positionCardNear(rect, step, tourMeta) {
      const card = q("#tour-card");
      card.style.transform = "translate(0,0)";
      card.innerHTML = "";
      card.appendChild(this.cardContent(step, tourMeta));

      const gap = 14;
      const cw = card.offsetWidth || 420;
      const ch = card.offsetHeight || 180;

      // Prefer right, else left, else below, else above
      let left = rect.right + gap;
      let top = rect.top;

      if (left + cw > window.innerWidth - 10) {
        left = rect.left - gap - cw;
      }
      if (left < 10) {
        left = Math.max(10, rect.left);
        top = rect.bottom + gap;
      }
      if (top + ch > window.innerHeight - 10) {
        top = Math.max(10, rect.top - gap - ch);
      }

      card.style.left = Math.round(left) + "px";
      card.style.top = Math.round(top) + "px";
    },
    cardContent(step, tourMeta) {
      const total = this.steps.length;
      const isLast = this.idx === total - 1;


      const wrap = el("div", {}, [
        el("div", { class: "kicker" }, [tourMeta?.title || "Tutorial"]),
        el("div", { class: "t" }, [step?.title || "Step"]),
        el("div", { class: "b", html: String(step?.body || "").replace(/\n/g, "<br>") }),
        el("div", { class: "tour-actions" }, [
          el("div", { class: "left" }, [
            el("span", { class: "tour-progress" }, [`${this.idx + 1} / ${total}`]),
          ]),
          el("div", { class: "right" }, [
            el("button", { class: "tour-btn", onclick: () => this.back(), disabled: this.idx === 0 }, ["Back"]),
            el("button", {
              class: "tour-btn primary",
              onclick: () => this.next()
            }, [isLast ? "Finish" : "Next"]),
            el("button", { class: "tour-btn", onclick: () => this.close() }, ["Close"]),
          ])
        ])
      ]);

    // Attach resources guide link handler (if present)
    setTimeout(() => {
      const guideLink = wrap.querySelector("#open-resources-guide");
      if (guideLink) {
        guideLink.addEventListener("click", (e) => {
          e.preventDefault();
          window.open("resources-guide.html", "_blank");
        });
      }
    }, 0);


      return wrap;
    }
  };

  // Public hook (optional)
  window.IntAssTour = {
    open: (key) => TourRunner.open(key),
    picker: () => TourPicker.open()
  };

  // ---------- Init ----------
  function init() {
    injectStyle();
    bindTitlebarIcon();
  }


  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  // Expose runner start for picker
  TourRunner.start = async (key) => TourRunner.open(key);
})();
