from .gemini_client import GeminiClient
from .groq_client import GroqClient
from .ollama_client import OllamaClient

class LLMManager:
    def __init__(self):
        # Initialize all your clients once
        self.clients = {
            "gemini": GeminiClient(),
            "groq": GroqClient(),
            "ollama": OllamaClient()
        }

    def get_client(self, provider_name: str):
        """Returns the requested client, defaulting to Gemini if not found."""
        provider = provider_name.lower()
        if provider not in self.clients:
            print(f"Warning: Provider '{provider}' not found. Falling back to Gemini.")
            return self.clients["gemini"]
        
        return self.clients[provider]

# Create a single instance to inject into FastAPI
llm_manager = LLMManager()

def get_llm_manager():
    return llm_manager