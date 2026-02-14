const path = require("path");
const { app } = require("electron");

function runtimeRoot() {
  // packaged: process.resourcesPath is inside runtime/resources typically
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, "..");
}

function resolveVoskModelDir() {
  // adjust to your final installer layout
  return app.isPackaged
    ? path.join(process.resourcesPath, "..", "vosk_model", "model-en-us")
    : path.join(__dirname, "..", "models", "model-en-us");
}

function resolveResourcesDir() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "resources")
    : path.join(__dirname, "..", "resources");
}

module.exports = { resolveVoskModelDir, resolveResourcesDir };
