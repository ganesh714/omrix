import json
import urllib.request

url = "http://localhost:8000/chat"
payload = {
    "messages": [
        {"role": "user", "parts": [{"text": "Execute the list_directory function with relative_path='.' and tell me the result."}]}
    ],
    "model": "gemini-2.5-flash",
    "workspace": "d:/Ganesh-D/Projects/VS-ext/backend"
}

data = json.dumps(payload).encode("utf-8")
req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})

try:
    with urllib.request.urlopen(req) as response:
        result = response.read()
        print("Status Code:", response.status)
        print("Response Body:")
        print(json.dumps(json.loads(result.decode("utf-8")), indent=2))
except Exception as e:
    print("Error:", e)
