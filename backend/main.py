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
# Helpers & Context Management
# =====================================================================

def estimate_tokens(text: str) -> int:
    """Rough estimation of tokens: ~4 chars per token."""
    return len(text) // 4

def prune_context(request: ChatRequest, max_tokens: int = 8000) -> ChatRequest:
    """
    Truncates tool results and drops old chat history to fit within max_tokens.
    """
    import copy
    new_request = copy.deepcopy(request)
    
    # 1. Truncate individual tool results to a sane limit (e.g. 10k chars / ~2.5k tokens)
    MAX_TOOL_CHARS = 10000 
    for tool_res in new_request.tool_history:
        if len(tool_res.content) > MAX_TOOL_CHARS:
            tool_res.content = tool_res.content[:MAX_TOOL_CHARS] + "\n\n[Content truncated by Omrix to save tokens...]"
            
    # 2. Estimate current total
    def calc_total():
        total = estimate_tokens(new_request.prompt)
        total += sum(estimate_tokens(msg["text"]) for msg in new_request.chat_history)
        total += sum(estimate_tokens(t.content) for t in new_request.tool_history)
        return total

    # 3. Drop oldest chat history if still too large
    while calc_total() > max_tokens and len(new_request.chat_history) > 1:
        # Keep the system instruction/initial prompt if it was there? 
        # Actually chat_history is just the conversation.
        new_request.chat_history.pop(0)
        
    return new_request

# =====================================================================
# API Endpoints
# =====================================================================

def call_groq(request: ChatRequest, system_instruction: str):
    actual_model = "llama-3.3-70b-versatile" # updated from decommissioned model
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

from clients.ollama_client import get_ollama_tools

async def call_ollama(request: ChatRequest, system_instruction: str):
    history = []
    # System instruction as system message
    history.append({"role": "system", "content": system_instruction})
    for msg in request.chat_history:
        role = "user" if msg["role"] == "user" else "assistant"
        history.append({"role": role, "content": msg["text"]})
        
    for tool_res in request.tool_history:
        # Prepend tool history as assistant/tool messages if supported, 
        # but for simplicity we keep them as part of the context.
        history.append({"role": "assistant", "content": f"Tool call: {tool_res.tool_name}({tool_res.arguments})"})
        history.append({"role": "user", "content": f"Tool result: {tool_res.content}"})
    
    ollama_tools = get_ollama_tools()
    message = await ollama_client.generate_response(prompt=request.prompt, history=history, tools=ollama_tools)
    
    if "tool_calls" in message and message["tool_calls"]:
        tool_call = message["tool_calls"][0]["function"]
        return {
            "type": "tool_call",
            "tool_name": tool_call["name"],
            "arguments": tool_call["arguments"]
        }
    
    response_text = message.get("content", "")
    print(f"DEBUG: Ollama Response: {response_text[:100]}...")
    return {"type": "message", "content": response_text}

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    try:
        system_instruction = (
            "You are Omrix, an expert AI coding assistant integrated into VS Code. "
            f"The user's current workspace directory is: {request.workspace}. "
            "You are FORBIDDEN from mentioning any filename that has not been explicitly returned by a tool in the current session. "
            "If you need to find a 'serverUrl', you must search for it using `search_in_files` or by using `list_directory` recursively until you find the relevant file. "
            "Never guess or give generic advice if you can read their actual code. "
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
        
        # Prune context to stay within free-tier limits (8k total tokens is safe for a 12k limit)
        safe_request = prune_context(request, max_tokens=8000)
        
        last_error = None
        for m in round_robin_order:
            print(f"DEBUG: Attempting model '{m}'")
            try:
                if m == 'gemini':
                    return call_gemini(safe_request, system_instruction)
                elif m == 'grok':
                    return call_groq(safe_request, system_instruction)
                elif m == 'ollama':
                    return await call_ollama(safe_request, system_instruction)
            except Exception as e:
                error_str = str(e)
                # If we still hit a 'Request too large' / 413, try one final aggressive prune
                if "413" in error_str or "too large" in error_str.lower():
                    print("DEBUG: Payload too large, trying one final aggressive prune...")
                    tiny_request = prune_context(safe_request, max_tokens=3000)
                    try:
                        if m == 'gemini': return call_gemini(tiny_request, system_instruction)
                        if m == 'grok': return call_groq(tiny_request, system_instruction)
                        if m == 'ollama': return await call_ollama(tiny_request, system_instruction)
                    except Exception as inner_e:
                        print(f"DEBUG: Aggressive prune also failed for '{m}': {inner_e}")
                
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
