// src/core/license/provider.js
class LicenseProvider {
  async firstBootProvisioning(_machineId) { return { ok: true }; }
  async evaluate(_machineId, _opts = {}) { return { ok: true, active: true, reason: "", source: "noop" }; }
  async startWatch(_machineId, _onDeactivated) { return { ok: true }; }
  async stopWatch() { return { ok: true }; }
}

module.exports = { LicenseProvider };
