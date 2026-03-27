import os
import logging
import json
from groq import Groq

logger = logging.getLogger(__name__)

# Basic Groq Tools conversion (using standard JSON Schema for OpenAI-compat tools)
# This mimics what we supply to Gemini.
groq_tools = [
     {
        "type": "function",
        "function": {
            "name": "list_directory",
            "description": "Lists the files and folders inside a specific directory within the workspace. Use this to understand the project structure.",
            "parameters": {
                "type": "object",
                "properties": {
                    "relative_path": {
                        "type": "string",
                        "description": "The path to the directory to list.",
                    }
                },
                "required": ["relative_path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Reads the content of a file within the workspace. Use this to inspect source code or text files.",
            "parameters": {
                "type": "object",
                "properties": {
                    "relative_path": {
                        "type": "string",
                        "description": "The path to the file to read.",
                    }
                },
                "required": ["relative_path"],
            },
        },
    }
]


class GroqClient:
    def __init__(self):
        api_key = os.getenv("GROQ_API_KEY")
        if not api_key or api_key == "your_groq_api_key_here":
            logger.warning("GROQ_API_KEY is not set or is a placeholder. Groq requests will fail.")
            self.client = None
        else:
            self.client = Groq(api_key=api_key)

    def generate_content(self, model: str, messages: list):
        if not self.client:
            raise Exception("Groq API client is not initialized. Ensure GROQ_API_KEY is set in .env.")
        
        try:
            # Fallback to a default text model if not specified
            active_model = model if model.startswith("llama") or model.startswith("mixtral") else "llama-3.1-70b-versatile"
            
            chat_completion = self.client.chat.completions.create(
                messages=messages,
                model=active_model,
                tools=groq_tools,
                tool_choice="auto"
            )
            
            return chat_completion.choices[0].message
        except Exception as e:
            logger.error(f"Groq API Error: {str(e)}")
            raise e

# Instantiate global Groq client
groq_service = GroqClient()
