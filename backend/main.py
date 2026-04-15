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
    tool_history: List[ToolResponseModel] = []
    chat_history: List[Dict[str, str]] = []


# Import OllamaClient at the top if it's missing, but we'll import it here dynamically just in case.
from clients.ollama_client import OllamaClient
ollama_client = OllamaClient()

# =====================================================================
# API Endpoints
# =====================================================================

def call_groq(request: ChatRequest, system_instruction: str):
    actual_model = "llama-3.1-70b-versatile" # default groq model since grok uses this in their setup
    messages = [{"role": "system", "content": system_instruction}]
    for msg in request.chat_history:
        role = "user" if msg["role"] == "user" else "assistant"
        messages.append({"role": role, "content": msg["text"]})
    
    messages.append({"role": "user", "content": request.prompt})
    for i, tool_res in enumerate(request.tool_history):
        call_id = f"call_{i}"
        messages.append({
            "role": "assistant",
            "content": None,
            "tool_calls": [{
                "id": call_id,
                "type": "function",
                "function": {
                    "name": tool_res.tool_name,
                    "arguments": json.dumps(tool_res.arguments)
                }
            }]
        })
        messages.append({
            "role": "tool",
            "tool_call_id": call_id,
            "name": tool_res.tool_name,
            "content": tool_res.content
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
        print(f"DEBUG: Groq Response: {response.content[:100]}...")
        return {"type": "message", "content": response.content}
    else:
        return {"type": "message", "content": "Received an empty response from Groq."}

def call_gemini(request: ChatRequest, system_instruction: str):
    actual_model = "gemini-2.5-pro"
    config = types.GenerateContentConfig(
        tools=agent_tools,
        temperature=0.0,
        system_instruction=system_instruction
    )
    
    contents = []
    for msg in request.chat_history:
        role = "user" if msg["role"] == "user" else "model"
        contents.append(types.Content(role=role, parts=[types.Part.from_text(text=msg["text"])]))
    
    contents.append(types.Content(role="user", parts=[types.Part.from_text(text=request.prompt)]))

    for tool_res in request.tool_history:
        contents.append(
            types.Content(role="model", parts=[
                types.Part.from_function_call(
                    name=tool_res.tool_name, 
                    args=tool_res.arguments 
                )
            ])
        )
        contents.append(
            types.Content(role="user", parts=[
                types.Part.from_function_response(
                    name=tool_res.tool_name,
                    response={"content": tool_res.content}
                )
            ])
        )
    
    response = gemini_service.generate_content(
        model=actual_model,
        contents=contents,
        config=config
    )
    if response.function_calls:
        tool_call = response.function_calls[0]
        return {
            "type": "tool_call",
            "tool_name": tool_call.name,
            "arguments": dict(tool_call.args) if tool_call.args else {}
        }
    elif response.text:
        print(f"DEBUG: Gemini Response: {response.text[:100]}...")
        return {"type": "message", "content": response.text}
    else:
        print("DEBUG: Gemini returned empty text and no function calls.")
        return {"type": "message", "content": "I have processed the data. Based on what I see, let me know if you would like me to continue with a file modification or if there's anything else I can do!"}

async def call_ollama(request: ChatRequest, system_instruction: str):
    history = []
    # System instruction isn't directly supported in the simple history format in ollama_client,
    # but we can pass it as a system message
    history.append({"role": "system", "content": system_instruction})
    for msg in request.chat_history:
        role = "user" if msg["role"] == "user" else "assistant"
        history.append({"role": role, "content": msg["text"]})
        
    # Ollama currently doesn't support our tool loop natively in the same way,
    # so we just prepend tool history to the prompt if any exists
    tool_text = ""
    for tool in request.tool_history:
        tool_text += f"\nTool {tool.tool_name} returned: {tool.content}"
        
    final_prompt = request.prompt + tool_text
    
    response_text = await ollama_client.generate_response(prompt=final_prompt, history=history)
    print(f"DEBUG: Ollama Response: {response_text[:100]}...")
    return {"type": "message", "content": response_text}

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    try:
        system_instruction = (
            "You are Omrix, an expert AI coding assistant integrated into VS Code. "
            f"The user's current workspace directory is: {request.workspace}. "
            "If the user asks about their project, folders (like 'frontend', 'backend'), or files, "
            "you MUST use your `list_directory` and `read_file` tools to investigate the filesystem "
            "BEFORE answering. Never guess or give generic advice if you can read their actual code. "
            "IMPORTANT: After using a tool, you should immediately use other tools (like 'modify_file') to finish the request if enough information or context has been gathered. "
            "Do NOT wait for the user to confirm after reading a file if you already know what needs to be changed. Be proactive and finish the entire objective autonomously."
        )

        selected_model = request.model.lower()
        if selected_model not in ['gemini', 'grok', 'ollama']:
            # map default backwards compatibility
            selected_model = 'gemini'
            
        # Create round-robin list prioritizing the selected model
        models = ['gemini', 'grok', 'ollama']
        models.remove(selected_model)
        round_robin_order = [selected_model] + models
        
        last_error = None
        for m in round_robin_order:
            print(f"DEBUG: Attempting model '{m}'")
            try:
                if m == 'gemini':
                    return call_gemini(request, system_instruction)
                elif m == 'grok':
                    return call_groq(request, system_instruction)
                elif m == 'ollama':
                    return await call_ollama(request, system_instruction)
            except Exception as e:
                print(f"DEBUG: Model '{m}' failed with error: {e}")
                last_error = e
                continue
                
        # If we exit the loop, all models failed
        print(f"DEBUG: All models failed. Last error: {last_error}")
        return {"type": "message", "content": "Server busy."}
            
    except Exception as e:
        print(f"ERROR: {str(e)}") 
        # Return fallback error msg instead of raising to not crash extension entirely without UI feedback
        return {"type": "message", "content": "Server busy."}
