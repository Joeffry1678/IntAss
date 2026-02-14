const { spawn } = require("child_process");
const path = require("path");

module.exports = function createPythonEngine({
  app,
  logToFile,
  sendToRenderer,
  sendStatus,
  sendToSplash,
  getDefaultModelsDir,
  getDefaultResourcesDir,
  getEngineExe,
  onEngineReady,
}) {


  let pythonProcess = null;
  let pendingPythonCmds = [];
  let engineReadyHandled = false;

	// -------------------------
	// Start Python
	// -------------------------
	function startPython() {
		
	  engineReadyHandled = false;

	  try { pythonProcess?.kill(); } catch {}
	  pythonProcess = null;


	  const engineCmd = app.isPackaged ? getEngineExe() : "python";
	  const engineArgs = app.isPackaged
	    ? []
	    : ["-u", path.join(__dirname, "..", "engine.py")];


	  sendStatus("Launching engine…");
	  logToFile(`engineCmd=${engineCmd}`);
	  logToFile(`engineArgs=${JSON.stringify(engineArgs)}`);

	  try {
		pythonProcess = spawn(engineCmd, engineArgs, {
		  windowsHide: true,
		  cwd: app.isPackaged ? process.resourcesPath : path.join(__dirname, ".."),
		  env: {
			...process.env,
			INTASS_MODELS_DIR: getDefaultModelsDir(),
			INTASS_RESOURCES_DIR: getDefaultResourcesDir(),
		  }
		});
	  } catch (e) {
		const msg = `spawn() threw: ${e?.message || e}`;
		sendStatus(msg, "error");
		logToFile(msg);
		return;
	  }

	  if (!pythonProcess) {
		const msg = "spawn() returned null pythonProcess";
		sendStatus(msg, "error");
		logToFile(msg);
		return;
	  }

	  // ✅ Guard: some spawn failures leave stdio null
	  if (!pythonProcess.stdout || !pythonProcess.stderr) {
		const msg = `spawn() no stdio: stdout=${!!pythonProcess.stdout} stderr=${!!pythonProcess.stderr}`;
		sendStatus(msg, "error");
		logToFile(msg);
		return;
	  }

	  setTimeout(() => flushPythonQueue(), 50);

	  let stdoutBuf = "";

	  pythonProcess.stdout.on("data", (data) => {
	    stdoutBuf += data.toString("utf8");

	    let idx;
	    while ((idx = stdoutBuf.indexOf("\n")) !== -1) {
			const line = stdoutBuf.slice(0, idx).trim();
			stdoutBuf = stdoutBuf.slice(idx + 1);

			if (!line) continue;

			// raw line to splash once (filtered elsewhere)
			try { sendToSplash?.(line); } catch {}
			logToFile(`[STDOUT] ${line}`);

			let msg;
			try {
			  msg = JSON.parse(line);
			} catch {
			  continue;
			}

			// send to renderer once
			sendToRenderer(msg);

			// show clean status text on splash once
			if (msg?.type === "status" && typeof msg.text === "string") {
			  try { sendToSplash?.(msg.text); } catch {}

			  // engine ready handling
			  if (msg.text.includes("Engine Ready")) {
				if (engineReadyHandled) continue;
				engineReadyHandled = true;

				sendStatus("Engine Ready.", "info");
				requestDevicesOnce();
				flushPythonQueue();

				try { onEngineReady?.(); } catch {}
			  }
			}

	    }
	  });


	  pythonProcess.stderr.on("data", (data) => {
		const text = data.toString();
		logToFile(`[STDERR] ${text.trimEnd()}`);

		const short = text.trim().split("\n").slice(-1)[0];
		if (!short) return;
		
		try { sendToSplash?.("[ERR] " + short); } catch {}


		if (/Ignoring wrong pointing object/i.test(short)) {
		  sendToRenderer({ type: "log", level: "warn", text: short });
		  return;
		}

		sendStatus(short, "warn");
	  });

	  pythonProcess.on("exit", (code) => {
		const msg = `Engine exited (code ${code})`;
		sendStatus(msg, "error");
		logToFile(msg);
	  });

	  pythonProcess.on("error", (err) => {
		const msg = `Engine spawn error: ${err?.message || err}`;
		sendStatus(msg, "error");
		logToFile(msg);
	  });
	}
   
	 function stopListeningBecauseMinimized() {
	  // stop engine capture
	  sendToPython({ cmd: "stop" });

	  // tell UI to reset capture state (optional but recommended)
	  sendToRenderer({ type: "ui_capture_stopped", reason: "minimized" });

	  // keep logs/status clean
	  sendStatus("Listening stopped (window minimized).", "warn");
	}  
	
	function flushPythonQueue() {
	  if (!pythonProcess?.stdin?.writable) return;
	  while (pendingPythonCmds.length) {
		const cmd = pendingPythonCmds.shift();
		try {
		  pythonProcess.stdin.write(JSON.stringify(cmd) + '\n');
		} catch (e) {
		  logToFile(`[QUEUE] flush write failed: ${e?.message || e}`);
		  break;
		}
	  }
	}
		
	function sendToPython(cmdObj) {
	  if (!pythonProcess || !pythonProcess.stdin || !pythonProcess.stdin.writable) {
		pendingPythonCmds.push(cmdObj);
		return false;
	  }
	  try {
		pythonProcess.stdin.write(JSON.stringify(cmdObj) + '\n');
		return true;
	  } catch (e) {
		pendingPythonCmds.push(cmdObj);
		return false;
	  }
	}
	
	
	
	function requestDevicesOnce() {
	  sendToPython({ cmd: "get_devices" });
	  setTimeout(() => sendToPython({ cmd: "get_devices" }), 1200); // one retry
	}  

   
return {
  start: startPython,
  send: sendToPython,
  stopListeningBecauseMinimized,
};

};


