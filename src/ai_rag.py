import os

try:
    import google.generativeai as genai
except Exception:
    genai = None

print("[AI_RAG] ai_rag.py LOADED", flush=True)


class AIResponder:
    def __init__(self):
        self.api_key = os.environ.get("GEMINI_API_KEY", "").strip()

        raw = os.environ.get("GEMINI_MODEL", "").strip()
        if not raw:
            raw = "gemini-pro"

        self.model_name = raw if raw.startswith("models/") else f"models/{raw}"

        self.max_ctx = int(os.environ.get("AI_MAX_CHARS_CONTEXT", "3500"))

        print("[AI] model:", self.model_name, "key_present:", bool(self.api_key), flush=True)

        self.enabled = bool(self.api_key) and (genai is not None)
        self.model = genai.GenerativeModel(self.model_name)       

        if self.enabled:
            genai.configure(api_key=self.api_key)
            self.model = genai.GenerativeModel(self.model_name)

    def answer(self, question: str, context: str) -> str:
        if not self.enabled or not self.model:
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


        resp = self.model.generate_content(prompt)
        return (getattr(resp, "text", None) or "").strip() or "No AI response."

