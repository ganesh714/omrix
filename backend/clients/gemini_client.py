import os
import logging
from typing import List, Dict, Any, Optional
from google import genai
from google.genai import types

logger = logging.getLogger(__name__)

# =====================================================================
# Tool Schema Definitions
# =====================================================================
agent_tools = [
    types.Tool(
        function_declarations=[
            types.FunctionDeclaration(
                name="list_directory",
                description="Lists the files and folders inside a specific directory within the workspace. Use this to understand the project structure.",
                parameters=types.Schema(
                    type=types.Type.OBJECT,
                    properties={
                        "relative_path": types.Schema(
                            type=types.Type.STRING,
                            description="The path to the directory to list."
                        )
                    },
                    required=["relative_path"]
                )
            ),
            types.FunctionDeclaration(
                name="read_file",
                description="Reads the content of a file within the workspace. Use this to inspect source code or text files.",
                parameters=types.Schema(
                    type=types.Type.OBJECT,
                    properties={
                        "relative_path": types.Schema(
                            type=types.Type.STRING,
                            description="The path to the file to read."
                        )
                    },
                    required=["relative_path"]
                )
            ),
            types.FunctionDeclaration(
                name="modify_file",
                description="Modifies an existing file by replacing a block of text. Use this to edit or update code/content inside a file.",
                parameters=types.Schema(
                    type=types.Type.OBJECT,
                    properties={
                        "relative_path": types.Schema(
                            type=types.Type.STRING,
                            description="The path to the file to modify."
                        ),
                        "old_text": types.Schema(
                            type=types.Type.STRING,
                            description="The exact text to be replaced. Must match exactly what is in the file."
                        ),
                        "new_text": types.Schema(
                            type=types.Type.STRING,
                            description="The new text to insert in place of the old_text."
                        )
                    },
                    required=["relative_path", "old_text", "new_text"]
                )
            ),
            types.FunctionDeclaration(
                name="search_in_files",
                description="Searches for a specific string or pattern across all files in the workspace. Use this to find variables, configurations, or specific code snippets.",
                parameters=types.Schema(
                    type=types.Type.OBJECT,
                    properties={
                        "query": types.Schema(
                            type=types.Type.STRING,
                            description="The text or string to search for."
                        )
                    },
                    required=["query"]
                )
            )
        ]
    )
]

class GeminiRotatorClient:
    """
    Client for Gemini API that rotates through a list of API keys.
    When a '429 Resource Exhausted' error is hit, it switches to the next available key.
    """
    def __init__(self):
        self.clients = []
        self.current_index = 0
        
        # Load all environment variables starting with GEMINI_API_KEY
        # Sort them so they are added sequentially if named like GEMINI_API_KEY_1, ..._2
        keys = sorted([k for k in os.environ.keys() if k.startswith("GEMINI_API_KEY")])
        for key in keys:
            api_key = os.environ.get(key)
            if api_key:
                try:
                    self.clients.append(genai.Client(api_key=api_key))
                    logger.info(f"Loaded Gemini key from {key}")
                except Exception as e:
                    logger.warning(f"Failed to initialize client with {key}: {e}")

        # Fallback to default if no specific keys found (e.g. standard lookup)
        if not self.clients:
            logger.info("No specific GEMINI_API_KEY_* found, trying default init.")
            self.clients.append(genai.Client())

    def get_current_client(self):
        return self.clients[self.current_index]

    def rotate_client(self):
        self.current_index = (self.current_index + 1) % len(self.clients)
        logger.warning(f"Rotated to Gemini API key index {self.current_index}")

    def generate_content(self, model: str, contents: List[Any], config: Any):
        max_retries = len(self.clients)
        attempts = 0
        last_exception = None

        while attempts < max_retries:
            client = self.get_current_client()
            try:
                response = client.models.generate_content(
                    model=model,
                    contents=contents,
                    config=config
                )
                return response
            except Exception as e:
                # `genai` SDK raises `google.genai.errors.APIError` for 429
                error_msg = str(e).lower()
                
                # Check if it corresponds to quota / rate limits
                if "429" in error_msg or "resource_exhausted" in error_msg or "quota" in error_msg:
                    logger.error(f"Gemini API key index {self.current_index} exhausted (429). Generating content failed.")
                    self.rotate_client()
                    attempts += 1
                    last_exception = e
                else:
                    # Reraise non-quota related exceptions immediately
                    raise e
        
        # If we broke out of loop without returning, all keys failed
        logger.critical(f"All {max_retries} Gemini API keys have exhausted quotas.")
        raise last_exception if last_exception else Exception("All Gemini API keys have exhausted their quotas.")

# Instantiate a single global client rotator to be reused
gemini_service = GeminiRotatorClient()
