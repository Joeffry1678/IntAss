# ai/provider_factory.py
from ai.providers.base import AIProvider
from ai.providers.gemini_provider import GeminiProvider

def create_ai_provider() -> AIProvider:
    # Later you can switch by env: AI_PROVIDER=gemini/openai/local/none
    return GeminiProvider()
