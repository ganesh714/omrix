"""
To install dependencies:
pip install -r requirements.txt

To run the server:
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
"""
import os
import json
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from google.genai import types

# Load environment variables from .env file FIRST
load_dotenv()

# Import clients after loading env vars
from clients.gemini_client import gemini_service, agent_tools
from clients.groq_client import groq_service

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
# Request Schema
# =====================================================================
class ToolResponseModel(BaseModel):
    tool_name: str
    content: str
    arguments: dict = {}

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
        actual_model = "gemini-2.5-flash" if request.model == "omrix" else request.model
        system_instruction = (
            "You are Omrix, an expert AI coding assistant integrated into VS Code. "
            f"The user's current workspace directory is: {request.workspace}. "
            "If the user asks about their project, folders (like 'frontend', 'backend'), or files, "
            "you MUST use your `list_directory` and `read_file` tools to investigate the filesystem "
            "BEFORE answering. Never guess or give generic advice if you can read their actual code."
        )

        # Route to Groq Client
        if actual_model.startswith("llama") or actual_model.startswith("mixtral") or actual_model.startswith("gemma"):
            messages = [{"role": "system", "content": system_instruction}]
            
            # Standard OpenAI-style message format for Groq
            if request.tool_response:
                messages.append({
                    "role": "user",
                    "content": request.prompt
                })
                messages.append({
                    "role": "assistant",
                    "content": None,
                    "tool_calls": [{
                        "id": "call_123", # Dummy ID since we don't cache
                        "type": "function",
                        "function": {
                            "name": request.tool_response.tool_name,
                            "arguments": json.dumps(request.tool_response.arguments)
                        }
                    }]
                })
                messages.append({
                    "role": "tool",
                    "tool_call_id": "call_123",
                    "name": request.tool_response.tool_name,
                    "content": request.tool_response.content
                })
            else:
                messages.append({
                    "role": "user",
                    "content": request.prompt
                })

            response = groq_service.generate_content(model=actual_model, messages=messages)

            if response.tool_calls:
                tool_call = response.tool_calls[0].function
                return {
                    "type": "tool_call",
                    "tool_name": tool_call.name,
                    "arguments": json.loads(tool_call.arguments)
                }
            elif response.content:
                return {
                    "type": "message",
                    "content": response.content
                }
            else:
                return {"type": "message", "content": "Received an empty response from Groq."}


        # Route to Gemini Client (Default)
        else:
            config = types.GenerateContentConfig(
                tools=agent_tools,
                temperature=0.0,
                system_instruction=system_instruction
            )
            
            contents = [
                types.Content(role="user", parts=[types.Part.from_text(text=request.prompt)])
            ]

            if request.tool_response:
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
            
            try:
                response = gemini_service.generate_content(
                    model=actual_model,
                    contents=contents,
                    config=config
                )
            except Exception as e:
                print(f"Gemini quota fully exhausted/error: {e}. Falling back to Groq.")
                # We reuse the Groq message formatting from above
                fallback_model = "llama-3.1-70b-versatile"
                messages = [{"role": "system", "content": system_instruction}]
                
                if request.tool_response:
                    messages.append({"role": "user", "content": request.prompt})
                    messages.append({
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [{
                            "id": "call_fallback",
                            "type": "function",
                            "function": {
                                "name": request.tool_response.tool_name,
                                "arguments": json.dumps(request.tool_response.arguments)
                            }
                        }]
                    })
                    messages.append({
                        "role": "tool",
                        "tool_call_id": "call_fallback",
                        "name": request.tool_response.tool_name,
                        "content": request.tool_response.content
                    })
                else:
                    messages.append({"role": "user", "content": request.prompt})

                # Call Groq instead
                fallback_response = groq_service.generate_content(model=fallback_model, messages=messages)

                if fallback_response.tool_calls:
                    tool_call = fallback_response.tool_calls[0].function
                    return {
                        "type": "tool_call",
                        "tool_name": tool_call.name,
                        "arguments": json.loads(tool_call.arguments)
                    }
                elif fallback_response.content:
                    return {
                        "type": "message",
                        "content": fallback_response.content
                    }
                else:
                    return {"type": "message", "content": "Received an empty response from Groq fallback."}
            
            # If Gemini succeeds normally
            if response.function_calls:
                tool_call = response.function_calls[0]
                return {
                    "type": "tool_call",
                    "tool_name": tool_call.name,
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
        print(f"ERROR: {str(e)}") 
        raise HTTPException(status_code=500, detail=f"API Error: {str(e)}")
