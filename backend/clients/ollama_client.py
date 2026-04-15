import os
import aiohttp

class OllamaClient:
    def __init__(self):
        # Defaults to localhost if the environment variable is not set
        self.base_url = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
        self.default_model = os.getenv("OLLAMA_MODEL", "llama3") 

    async def generate_response(self, prompt: str, history: list = None):
        url = f"{self.base_url}/api/chat"
        
        # Ensure history format matches Ollama's expectation
        messages = history if history else []
        messages.append({"role": "user", "content": prompt})

        payload = {
            "model": self.default_model,
            "messages": messages,
            "stream": False
        }

        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload) as response:
                if response.status != 200:
                    raise Exception(f"Ollama Error: {await response.text()}")
                
                data = await response.json()
                return data["message"]["content"]