import os

try:
    import google.generativeai as genai
except Exception:
    genai = None

print("[AI_RAG] ai_rag.py LOADED", flush=True)


class AIResponder:
    def __init__(self):
        self.api_key = os.environ.get("GEMINI_API_KEY", "").strip()

        raw_model = os.environ.get("GEMINI_MODEL", "").strip() or "gemini-pro"
        self.model_name = raw_model if raw_model.startswith("models/") else f"models/{raw_model}"

        self.max_ctx = int(os.environ.get("AI_MAX_CHARS_CONTEXT", "3500"))

        # Enabled only if BOTH key and library exist
        self.enabled = bool(self.api_key) and (genai is not None)
        self.model = None

        print(
            "[AI] model:", self.model_name,
            "key_present:", bool(self.api_key),
            "genai_present:", genai is not None,
            "enabled:", self.enabled,
            flush=True
        )

        if not self.enabled:
            return

        # Configure first, then create the model
        genai.configure(api_key=self.api_key)
        self.model = genai.GenerativeModel(self.model_name)

    def answer(self, question: str, context: str) -> str:
        if not self.enabled or not self.model:
            return "AI is not configured. Add GEMINI_API_KEY (and install google-generativeai)."

        ctx = (context or "").strip()
        if len(ctx) > self.max_ctx:
            ctx = ctx[: self.max_ctx] + "\n\n[context truncated]"

        prompt = f"""
You are a Tier 2 Help Desk Engineer at an MSP. Your job is to solve the problem quickly and clearly.

RULES (must follow):
- Be concise and scenario-based. No long explanations or definitions unless the user asks.
- Start by scoping impact: one user vs multiple users, single site vs all sites, since when.
- Give a logical troubleshooting order: Quick checks -> Tests -> Isolate -> Fix -> Escalate.
- Use bullets and short lines. Prefer commands and exact checks.
- If permissions are needed, say what you'd do and what you'd escalate to.
- Do NOT mention the word "CONTEXT" or talk about whether it was sufficient. Use it silently if helpful.
- If info is missing, make reasonable assumptions and proceed, but call out what you’re assuming in 1 line.

OUTPUT FORMAT (always use):
**Scope / Impact**
- ...

**Quick Checks**
- ...

**Tests (what I run / verify)**
- ...

**Isolate**
- ...

**Fix**
- ...

**Escalate / Next Step (if needed)**
- ...

STYLE EXAMPLES (imitate this style):

Example – DNS issue:
**Scope / Impact**
- Confirm: 1 user or multiple users? Single subnet or all sites?

**Quick Checks**
- Check link/VPN status; confirm correct network adapter.

**Tests (what I run / verify)**
- `ipconfig /all`
- `nslookup google.com`
- `ping <dns_server_ip>` and `ping 8.8.8.8`

**Isolate**
- If ping works but nslookup fails: DNS resolution issue.
- If multiple users: check DNS server health/reachability.

**Fix**
- `ipconfig /flushdns` then `ipconfig /renew`
- Set correct DNS servers; restart DNS Client service if needed.

**Escalate / Next Step (if needed)**
- If DNS server down/unreachable: escalate to Infra / restart DNS service if authorized.

Now answer the user.

{("REFERENCE NOTES:\n" + ctx) if ctx else ""}

QUESTION:
{question}
""".strip()

        try:
            resp = self.model.generate_content(prompt)
            text = (getattr(resp, "text", None) or "").strip()
            return text or "No AI response."
        except Exception as e:
            return f"AI error: {e}"