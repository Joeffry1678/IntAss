# ai/providers/gemini_provider.py
import os

try:
    from google import genai
except Exception:
    genai = None

from .base import AIProvider


class GeminiProvider(AIProvider):
    def __init__(self):
        self.api_key = os.environ.get("GEMINI_API_KEY", "").strip()
        raw = os.environ.get("GEMINI_MODEL", "").strip() or "gemini-2.0-flash"

        # keep your "models/..." normalization
        self.model_name = raw if raw.startswith("models/") else raw.replace("models/", "")
        self.max_ctx = int(os.environ.get("AI_MAX_CHARS_CONTEXT", "3500"))

        self._enabled = bool(self.api_key) and (genai is not None)
        self.client = None

        if self._enabled:
            # ✅ new SDK style
            self.client = genai.Client(api_key=self.api_key)

    def enabled(self) -> bool:
        return self._enabled and (self.client is not None)

    def answer(self, question: str, context: str) -> str:
        if not self.enabled():
            return "AI is not configured. Add GEMINI_API_KEY to .env."

        ctx = (context or "").strip()
        if len(ctx) > self.max_ctx:
            ctx = ctx[: self.max_ctx] + "\n\n[context truncated]"

        prompt = f"""You are a helpful assistant.

Use the CONTEXT if it is relevant, but do not mention the context, do not summarize it, and do not say whether it was sufficient or insufficient.
If the context is not helpful, ignore it and answer normally.

CONTEXT:
{ctx}

QUESTION:
{question}

Give a clear answer with good formatting:
- Use short paragraphs
- If the answer is too technical make it more understandable to a non-technical person
- Use numbered steps when applicable
- Add blank lines between sections
- If the question is personal or about me prompt your answer as "I" not "You"
"""

        # ✅ new SDK call style
        resp = self.client.models.generate_content(
            model=self.model_name,
            contents=prompt,
        )

        text = getattr(resp, "text", "") or ""
        return text.strip() or "No AI response."
