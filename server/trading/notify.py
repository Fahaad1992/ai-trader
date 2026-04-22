import os
import threading
import requests

TOKEN = os.getenv("TG_TOKEN")
CHAT_ID = os.getenv("TG_CHAT_ID")

def send(msg):
    if not TOKEN or not CHAT_ID:
        return
    def _send():
        try:
            url = f"https://api.telegram.org/bot{TOKEN}/sendMessage"
            requests.post(url, json={"chat_id": CHAT_ID, "text": msg}, timeout=1)
        except:
            pass
    threading.Thread(target=_send, daemon=True).start()
