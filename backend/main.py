"""
To install dependencies:
pip install -r requirements.txt

To run the server:
uvicorn main:app --host 127.0.0.1 --port 8000 --reload
"""
import os
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from google import genai
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()

# Initialize the GenAI client using the key from environment variables
# Note: If no api_key is passed explicitly, it defaults to using the GOOGLE_API_KEY env variable.
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

# Pydantic model for the incoming request body
class ChatRequest(BaseModel):
    prompt: str

@app.post("/chat")
async def chat_endpoint(request: ChatRequest):
    try:
        # Pass the prompt to Gemini and get the response
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=request.prompt
        )
        
        # Return the response text
        return {"response": response.text}
    except Exception as e:
        # Return a 500 error if the Gemini API fails
        raise HTTPException(status_code=500, detail=f"Gemini API Error: {str(e)}")
