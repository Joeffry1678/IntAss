# ai/providers/base.py
class AIProvider:
    def enabled(self) -> bool:
        return False

    def answer(self, question: str, context: str) -> str:
        return "AI is disabled."
