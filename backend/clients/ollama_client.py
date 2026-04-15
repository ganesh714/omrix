import os
import aiohttp

class OllamaClient:
    def __init__(self):
        # Defaults to localhost if the environment variable is not set
        self.base_url = os.getenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
        self.default_model = os.getenv("OLLAMA_MODEL", "llama3") 

    async def generate_response(self, prompt: str, history: list = None, tools: list = None):
        url = f"{self.base_url}/api/chat"
        
        # Ensure history format matches Ollama's expectation
        messages = history if history else []
        messages.append({"role": "user", "content": prompt})

        payload = {
            "model": self.default_model,
            "messages": messages,
            "stream": False
        }
        if tools:
            payload["tools"] = tools

        async with aiohttp.ClientSession() as session:
            async with session.post(url, json=payload) as response:
                if response.status != 200:
                    raise Exception(f"Ollama Error: {await response.text()}")
                
                data = await response.json()
                return data["message"]

def get_ollama_tools():
    return [
        {
            "type": "function",
            "function": {
                "name": "list_directory",
                "description": "Lists the files and folders inside a specific directory within the workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "relative_path": {"type": "string", "description": "The path to the directory to list."}
                    },
                    "required": ["relative_path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Reads the content of a file within the workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "relative_path": {"type": "string", "description": "The path to the file to read."}
                    },
                    "required": ["relative_path"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "modify_file",
                "description": "Modifies an existing file by replacing a block of text.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "relative_path": {"type": "string", "description": "The path to the file to modify."},
                        "old_text": {"type": "string", "description": "The exact text to be replaced."},
                        "new_text": {"type": "string", "description": "The new text to insert."}
                    },
                    "required": ["relative_path", "old_text", "new_text"]
                }
            }
        },
        {
            "type": "function",
            "function": {
                "name": "search_in_files",
                "description": "Searches for a specific string or pattern across all files in the workspace.",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {"type": "string", "description": "The text or string to search for."}
                    },
                    "required": ["query"]
                }
            }
        }
    ]