// src/integrations/supabase/supabase_license_provider.js
const { createClient } = require("@supabase/supabase-js");

class SupabaseLicenseProvider {
  constructor({ url, anonKey, logger }) {
    this.url = url;
    this.anonKey = anonKey;
    this.logger = logger;
    this.sb = null;
    this.channel = null;
    this.watchedMid = null;
  }

  _client() {
    if (this.sb) return this.sb;
    if (!this.url || !this.anonKey) return null;

    this.sb = createClient(this.url, this.anonKey, {
      auth: { persistSession: false, autoRefreshToken: true, detectSessionInUrl: false },
      realtime: { params: { eventsPerSecond: 5 } }
    });

    return this.sb;
  }

  async isOnline(timeoutMs = 3000) {
    try {
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), timeoutMs);

      const res = await fetch(`${this.url}/rest/v1/`, {
        method: "GET",
        headers: { apikey: this.anonKey },
        signal: controller.signal
      });

      clearTimeout(t);
      return !!res;
    } catch {
      return false;
    }
  }

  async fetchStatus(machineId) {
    const sb = this._client();
    if (!sb) return { ok: false, active: false, reason: "Supabase not configured" };

    const mid = String(machineId || "").trim();
    if (!mid) return { ok: false, active: false, reason: "Missing machine id" };

    const { data, error } = await sb
      .from("licenses")
      .select("active, expiry_date, reason, name, email, metadata, updated_at")
      .eq("machine_id", mid)
      .maybeSingle();

    if (error) return { ok: false, active: false, reason: error.message };
    if (!data) return { ok: true, active: false, reason: "No license found" };
    if (!data.active) return { ok: true, active: false, reason: data.reason || "Deactivated" };
    if (data.expiry_date && new Date(data.expiry_date) <= new Date()) {
      return { ok: true, active: false, reason: "License expired" };
    }

    return { ok: true, active: true, reason: "", license: data };
  }

  async ensureRowExists(machineId) {
    const sb = this._client();
    if (!sb) return { ok: false, error: "Supabase not configured" };

    const mid = String(machineId || "").trim();
    if (!mid) return { ok: false, error: "Missing machine id" };

    try {
      const { error } = await sb
        .from("licenses")
        .upsert(
          {
            machine_id: mid,
            active: false,
            reason: "Pending activation",
            metadata: { first_seen_app: "intass" }
          },
          { onConflict: "machine_id" }
        );

      if (error) return { ok: false, error: error.message };
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  }

  async startWatch(machineId, onDeactivated) {
    const sb = this._client();
    if (!sb) return { ok: false, error: "Supabase not configured" };

    const mid = String(machineId || "").trim();
    if (!mid) return { ok: false, error: "Missing machine id" };

    // ✅ avoid duplicates
    if (this.channel && this.watchedMid === mid) {
      this.logger?.log?.(`[LICENSE] watch already active for ${mid}`);
      return { ok: true, already: true };
    }

    await this.stopWatch();
    this.watchedMid = mid;

    // ✅ CRITICAL: do an immediate fetch NOW (this fixes “need to toggle twice”)
    try {
      const st0 = await this.fetchStatus(mid);
      if (!st0.ok || !st0.active) onDeactivated(st0.reason || "Deactivated");
    } catch (e) {
      this.logger?.log?.(`[LICENSE] initial fetch failed: ${e?.message || e}`);
    }

    this.channel = sb
      .channel(`license:${mid}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "licenses", filter: `machine_id=eq.${mid}` },
		async (payload) => {
		  try {
			this.logger?.log?.(`[LICENSE] realtime change: ${payload?.eventType || "?"}`);

			const { data, error } = await sb
			  .from("licenses")
			  .select("active, expiry_date, reason")
			  .eq("machine_id", mid)
			  .maybeSingle();

			if (error) {
			  this.logger?.log?.(`[LICENSE] realtime fetch error: ${error.message}`);
			  return;
			}

			if (!data || !data.active) {
			  onDeactivated(data?.reason || "Deactivated");
			}

		  } catch (e) {
			this.logger?.log?.(`[LICENSE] realtime handler error: ${e?.message || e}`);
		  }
		}

      )
      .subscribe((status, err) => {
        this.logger?.log?.(`[LICENSE] realtime status=${status}${err ? " err=" + err.message : ""}`);
      });

    return { ok: true };
  }

  async stopWatch() {
    try {
      const sb = this._client();
      if (this.channel && sb) {
        try { await sb.removeChannel(this.channel); } catch {}
      }
    } finally {
      this.channel = null;
      this.watchedMid = null;
    }
    return { ok: true };
  }
}

module.exports = { SupabaseLicenseProvider };
