"""
To install dependencies:
pip install -r requirements.txt

To run the server:
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
"""
import os
from typing import List, Dict, Any, Optional
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
class ToolResponseModel(BaseModel):
    tool_name: str
    content: str
    arguments: dict = {} # Added to accept args from VS Code

class ChatRequest(BaseModel):
    prompt: str  
    model: str
    workspace: str
    tool_response: Optional[ToolResponseModel] = None


# =====================================================================
# API Endpoints
# =====================================================================

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    try:
        config = types.GenerateContentConfig(
            tools=agent_tools,
            temperature=0.0,
            system_instruction=(
                "You are Omrix, an expert AI coding assistant integrated into VS Code. "
                f"The user's current workspace directory is: {request.workspace}. "
                "If the user asks about their project, folders (like 'frontend', 'backend'), or files, "
                "you MUST use your `list_directory` and `read_file` tools to investigate the filesystem "
                "BEFORE answering. Never guess or give generic advice if you can read their actual code."
            )
        )
        
        contents = [
            types.Content(role="user", parts=[types.Part.from_text(text=request.prompt)])
        ]

        if request.tool_response:
            # Tell Gemini exactly what arguments it used last time
            contents.append(
                types.Content(role="model", parts=[
                    types.Part.from_function_call(
                        name=request.tool_response.tool_name, 
                        args=request.tool_response.arguments 
                    )
                ])
            )
            contents.append(
                types.Content(role="user", parts=[
                    types.Part.from_function_response(
                        name=request.tool_response.tool_name,
                        response={"content": request.tool_response.content}
                    )
                ])
            )
        
        # Safest fallback model
        actual_model = "gemini-2.5-flash" if request.model == "omrix" else request.model

        response = client.models.generate_content(
            model=actual_model,
            contents=contents,
            config=config
        )
        
        if response.function_calls:
            tool_call = response.function_calls[0]
            return {
                "type": "tool_call",
                "tool_name": tool_call.name,
                # Safely convert to a native dictionary so FastAPI doesn't crash
                "arguments": dict(tool_call.args) if tool_call.args else {}
            }
            
        elif response.text:
            return {
                "type": "message",
                "content": response.text
            }
        
        else:
            return {"type": "message", "content": "Received an empty response."}
            
    except Exception as e:
        # This will print the exact Gemini error to your terminal!
        print(f"ERROR: {str(e)}") 
        raise HTTPException(status_code=500, detail=f"Gemini API Error: {str(e)}")
