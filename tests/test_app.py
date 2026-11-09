import json
import os
import unittest
from unittest.mock import patch

import app
from agent import calculate, read_notes, run_agent_details


class BackendTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        app.app.config.update(TESTING=True)
        cls.client = app.app.test_client()

    def test_frontend_and_health(self):
        root = self.client.get("/")
        health = self.client.get("/api/health")
        self.assertEqual(root.status_code, 200)
        self.assertIn('id="root"', root.get_data(as_text=True))
        root.close()
        self.assertEqual(health.status_code, 200)
        self.assertEqual(health.json["status"], "CodeMentor AI backend is running")

    @patch("app.run_agent_details", return_value={"answer": "A class is a blueprint.", "tools": []})
    def test_valid_chat(self, _agent):
        response = self.client.post("/api/chat", json={"message": "What is a class?"})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json["answer"], "A class is a blueprint.")

    def test_chat_validation(self):
        cases = [
            (b"not json", "text/plain", 400),
            (b"null", "application/json", 400),
            (json.dumps({"message": 42}).encode(), "application/json", 400),
            (json.dumps({"message": " "}).encode(), "application/json", 400),
            (json.dumps({"message": "x" * 2001}).encode(), "application/json", 413),
        ]
        for body, content_type, status in cases:
            with self.subTest(status=status):
                response = self.client.post(
                    "/api/chat",
                    data=body,
                    content_type=content_type,
                )
                self.assertEqual(response.status_code, status)
                self.assertIn("error", response.json)

    def test_calculator(self):
        self.assertEqual(calculate("2 + 3"), "5")
        self.assertEqual(calculate("6 * 7"), "42")
        self.assertEqual(calculate("1 / 0"), "Cannot divide by zero.")
        self.assertEqual(
            calculate("__import__('os').getcwd()"),
            "Invalid mathematical expression.",
        )

    def test_notes_are_retrievable(self):
        self.assertTrue(read_notes())

    @patch.dict(os.environ, {}, clear=True)
    def test_missing_gemini_key(self):
        result = run_agent_details("hello")
        self.assertEqual(result["answer"], "The AI service is not configured.")

    @patch("agent.get_client", side_effect=RuntimeError("invalid API key"))
    @patch.dict(os.environ, {"GEMINI_API_KEY": "test-key"}, clear=True)
    def test_invalid_gemini_key_is_safe(self, _get_client):
        result = run_agent_details("hello")
        self.assertEqual(
            result["answer"],
            "The AI service is not configured correctly.",
        )

    @patch("agent.get_client", side_effect=TimeoutError())
    @patch.dict(os.environ, {"GEMINI_API_KEY": "test-key"}, clear=True)
    def test_gemini_timeout_is_safe(self, _get_client):
        result = run_agent_details("hello")
        self.assertEqual(
            result["answer"],
            "The AI service timed out. Please try again.",
        )


if __name__ == "__main__":
    unittest.main()
