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
    },
    {
        "type": "function",
        "function": {
            "name": "modify_file",
            "description": "Modifies an existing file by replacing a block of text. Use this to edit or update code/content inside a file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "relative_path": {
                        "type": "string",
                        "description": "The path to the file to modify.",
                    },
                    "old_text": {
                        "type": "string",
                        "description": "The exact text to be replaced. Must match exactly what is in the file.",
                    },
                    "new_text": {
                        "type": "string",
                        "description": "The new text to insert in place of the old_text.",
                    }
                },
                "required": ["relative_path", "old_text", "new_text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_in_files",
            "description": "Searches for a specific string or pattern across all files in the workspace. Use this to find variables, configurations, or specific code snippets.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The text or string to search for.",
                    }
                },
                "required": ["query"],
            },
        },
    }
]


class GroqRotatorClient:
    """
    Client for Groq API that rotates through a list of API keys.
    When a '429 Rate Limit' error is hit, it switches to the next available key.
    """
    def __init__(self):
        self.clients = []
        self.current_index = 0
        
        # Load all environment variables starting with GROQ_API_KEY
        keys = sorted([k for k in os.environ.keys() if k.startswith("GROQ_API_KEY")])
        for key in keys:
            api_key = os.environ.get(key)
            if api_key and api_key != "your_groq_api_key_here" and not api_key.startswith("your_groq_api_key"):
                try:
                    self.clients.append(Groq(api_key=api_key))
                    logger.info(f"Loaded Groq key from {key}")
                except Exception as e:
                    logger.warning(f"Failed to initialize Groq client with {key}: {e}")

        # Fallback to standard check if no specific keys found (could pick up standard GROQ_API_KEY from environment)
        if not self.clients:
            api_key = os.environ.get("GROQ_API_KEY")
            if api_key and not api_key.startswith("your_groq"):
                self.clients.append(Groq(api_key=api_key))
                logger.info("Loaded standard Groq key")
            else:
                logger.warning("No valid GROQ_API_KEY_* found in .env. Groq fallback will fail.")

    def get_current_client(self):
        if not self.clients:
             raise Exception("Groq API client is not initialized. Ensure valid GROQ_API_KEY_* are set.")
        return self.clients[self.current_index]

    def rotate_client(self):
        if self.clients:
            self.current_index = (self.current_index + 1) % len(self.clients)
            logger.warning(f"Rotated to Groq API key index {self.current_index}")

    def generate_content(self, model: str, messages: list):
        if not self.clients:
            raise Exception("Groq API client is not initialized. Ensure valid GROQ_API_KEY_* are set.")
            
        max_retries = len(self.clients)
        attempts = 0
        last_exception = None

        active_model = model if model.startswith("llama") or model.startswith("mixtral") or model.startswith("gemma") else "llama-3.1-70b-versatile"
            
        while attempts < max_retries:
            client = self.get_current_client()
            try:
                chat_completion = client.chat.completions.create(
                    messages=messages,
                    model=active_model,
                    tools=groq_tools,
                    tool_choice="auto"
                )
                return chat_completion.choices[0].message
            except Exception as e:
                error_msg = str(e).lower()
                # Check for rate limit (429) or payload size (413) errors from Groq
                if "429" in error_msg or "rate limit" in error_msg or "413" in error_msg or "too large" in error_msg:
                    logger.error(f"Groq API key index {self.current_index} failed (quota or size).")
                    self.rotate_client()
                    attempts += 1
                    last_exception = e
                else:
                    # Reraise immediately if it's not a rate/size limit
                    raise e
        
        logger.critical(f"All {max_retries} Groq API keys have exhausted limits.")
        raise last_exception if last_exception else Exception("All Groq API keys have exhausted their limits.")

# Instantiate global Groq client
groq_service = GroqRotatorClient()
