import asyncio
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch


SERVICE_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(SERVICE_ROOT))

from app.openai_client import create_openai_http_client


class ManimOpenAIClientTests(unittest.TestCase):
    def test_http_client_ignores_malformed_no_proxy_by_default(self):
        with patch.dict(
            os.environ,
            {
                "NO_PROXY": "localhost,127.0.0.1,::1",
                "no_proxy": "localhost,127.0.0.1,::1",
                "MANIM_OPENAI_TRUST_ENV": "",
                "MANIM_OPENAI_PROXY": "",
            },
            clear=False,
        ):
            client = create_openai_http_client(1.0)

        try:
            self.assertFalse(getattr(client, "_trust_env", True))
        finally:
            asyncio.run(client.aclose())


if __name__ == "__main__":
    unittest.main()
