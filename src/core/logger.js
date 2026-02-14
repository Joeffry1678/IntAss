const { app } = require('electron');
const fs = require('fs');
const path = require('path');

function logToFile(msg) {
  try {
    const logPath = path.join(app.getPath('userData'), 'python.log');

    const utc = new Date().toISOString();
    const local = new Date().toLocaleString();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown-tz";

    fs.appendFileSync(logPath, `[${utc}] [${local} ${tz}] ${msg}\n`);
  } catch {}
}

module.exports = { logToFile };
