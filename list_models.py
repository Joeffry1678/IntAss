import os
from dotenv import load_dotenv

# load .env from your project root
load_dotenv(os.path.join(os.path.dirname(__file__), ".env"))

import google.generativeai as genai

genai.configure(api_key=os.environ["GEMINI_API_KEY"])

print("=== Models that support generateContent ===")
for m in genai.list_models():
    methods = getattr(m, "supported_generation_methods", []) or []
    if "generateContent" in methods:
        print(m.name, methods)
