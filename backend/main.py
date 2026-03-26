"""
To install dependencies:
pip install -r requirements.txt

To run the server:
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
"""
import os
from typing import List, Dict, Any
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from google import genai
from google.genai import types
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# Initialize the GenAI client using the key from environment variables
api_key = os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")
if api_key:
    client = genai.Client(api_key=api_key)
else:
    client = genai.Client()

app = FastAPI()

# Configure CORS to allow requests from the VS Code Webview
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =====================================================================
# Tool Schema Definitions
# By defining these as pure schemas (types.Tool), the SDK cannot 
# execute them automatically. It will just ask the client to do it.
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
            )
        ]
    )
]


# =====================================================================
# Request Schema
# =====================================================================

class ChatRequest(BaseModel):
    # Expect a complete conversation history from the client
    # Expected format: [{"role": "user", "parts": [{"text": "Hello"}]}, ...]
    messages: List[Dict[str, Any]]
    model: str = "gemini-2.5-flash"
    workspace: str


# =====================================================================
# API Endpoints
# =====================================================================

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    try:
        # Configure the generation settings with our explicit tool schemas
        config = types.GenerateContentConfig(
            tools=agent_tools,
            temperature=0.0
        )
        
        # Send the full message history to Gemini.
        response = client.models.generate_content(
            model=request.model,
            contents=request.messages,
            config=config
        )
        
        # Scenario 1: Gemini decides it needs to execute a tool
        if response.function_calls:
            # For simplicity, extract the first requested function call
            tool_call = response.function_calls[0]
            
            # Delegate execution to the VS Code Client
            return {
                "type": "tool_call",
                "tool_name": tool_call.name,
                "arguments": tool_call.args
            }
            
        # Scenario 2: Gemini returns a standard text response
        elif response.text:
            return {
                "type": "message",
                "content": response.text
            }
        
        # Fallback scenario
        else:
            return {
                "type": "message",
                "content": "Received an empty or unsupported response from Gemini."
            }
            
    except Exception as e:
        # Return a 500 error if the Gemini API fails
        raise HTTPException(status_code=500, detail=f"Gemini API Error: {str(e)}")

