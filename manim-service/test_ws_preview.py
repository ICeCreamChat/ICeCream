import asyncio
import websockets
import json

async def test_preview():
    uri = "ws://localhost:8001/ws/chat"
    try:
        async with websockets.connect(uri) as websocket:
            print("Connected to WebSocket")
            
            # Send prompt
            prompt = "画一个红色的圆形"
            payload = json.dumps({"prompt": prompt})
            await websocket.send(payload)
            print(f"Sent prompt: {payload}")
            
            while True:
                response = await websocket.recv()
                data = json.loads(response)
                print(f"Received: {data['type']}")
                
                if data['type'] == 'preview':
                    print("✅ Preview received!")
                    print(f"URL: {data['url']}")
                    break
                
                if data['type'] == 'error':
                    print(f"❌ Error: {data.get('message')}")
                    break
                
                if data['type'] == 'video':
                    print("⚠️ Video received before preview? Test failed/Preview skipped.")
                    break
                    
    except Exception as e:
        print(f"Connection error: {e}")

if __name__ == "__main__":
    asyncio.run(test_preview())
