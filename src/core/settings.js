const { app } = require('electron');
const path = require('path');
const fs = require('fs');

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const p = settingsPath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

function saveSettings(obj) {
  try {
    fs.writeFileSync(settingsPath(), JSON.stringify(obj, null, 2), 'utf8');
  } catch {}
}

module.exports = {
  loadSettings,
  saveSettings,
  settingsPath
};
