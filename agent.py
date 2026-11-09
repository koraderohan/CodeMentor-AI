import ast
import logging
import math
import os
import time
from datetime import datetime
from pathlib import Path

from google import genai
from google.genai import types


logger = logging.getLogger(__name__)

MODEL = "gemini-3.5-flash-lite"
NOTES_PATH = Path(__file__).with_name("java_notes.txt").resolve()
MAX_NOTES_BYTES = 100_000
MAX_AGENT_ITERATIONS = 3
API_TIMEOUT_MS = 30_000
MAX_CALCULATION_LENGTH = 200
MAX_CALCULATION_NODES = 50
_client = None
_client_api_key = None


SYSTEM_PROMPT = """
You are CodeMentor AI, a Java Study Agent.

When explaining any topic:

1. Start with one plain-language definition in one line.
2. Give one everyday Indian student-life example.
3. Explain step by step in short points.
4. For code, show at most 10 lines and comment important lines.
5. Use a Mermaid diagram when a visual helps.
6. End with a two-line summary and ask:
   "Want a quick quiz on this?"
7. Use the student's notes first when they contain the topic,
   then simplify them.
8. Keep answers under 200 words unless the student asks for
   more detail.

Use clear Markdown headings, lists, and fenced code blocks.
Use tools when they are useful.
Never invent information from the student's notes.
After using a tool, use its result to answer the user.
"""


def _calculate_node(node, depth=0):
    if depth > MAX_CALCULATION_NODES:
        raise ValueError("Expression is too complex.")

    if isinstance(node, ast.Expression):
        return _calculate_node(node.body, depth + 1)

    if isinstance(node, ast.Constant) and (
        isinstance(node.value, (int, float))
        and not isinstance(node.value, bool)
    ):
        return node.value

    if isinstance(node, ast.UnaryOp) and isinstance(
        node.op, (ast.UAdd, ast.USub)
    ):
        value = _calculate_node(node.operand, depth + 1)
        return value if isinstance(node.op, ast.UAdd) else -value

    if isinstance(node, ast.BinOp) and isinstance(
        node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Mod)
    ):
        left = _calculate_node(node.left, depth + 1)
        right = _calculate_node(node.right, depth + 1)
        if isinstance(node.op, ast.Add):
            return left + right
        if isinstance(node.op, ast.Sub):
            return left - right
        if isinstance(node.op, ast.Mult):
            return left * right
        if isinstance(node.op, ast.Div):
            return left / right
        return left % right

    raise ValueError("Only basic arithmetic is supported.")


def calculate(expression):
    """Safely calculate basic arithmetic without executing Python code."""
    if not isinstance(expression, str):
        return "Invalid mathematical expression."
    if not expression.strip() or len(expression) > MAX_CALCULATION_LENGTH:
        return "Invalid mathematical expression."

    try:
        tree = ast.parse(expression, mode="eval")
        if sum(1 for _ in ast.walk(tree)) > MAX_CALCULATION_NODES:
            return "Expression is too complex."
        result = _calculate_node(tree)
        if not math.isfinite(result):
            return "Calculation result is not finite."
        return str(result)
    except ZeroDivisionError:
        return "Cannot divide by zero."
    except (SyntaxError, TypeError, ValueError, OverflowError):
        return "Invalid mathematical expression."


def read_notes():
    """Read only the fixed Java notes file."""
    notes_root = Path(__file__).resolve().parent
    if notes_root not in NOTES_PATH.parents or not NOTES_PATH.is_file():
        return "Java notes are unavailable."

    try:
        return NOTES_PATH.read_text(
            encoding="utf-8",
            errors="replace",
        )[:MAX_NOTES_BYTES]
    except OSError:
        return "Java notes are unavailable."


def get_current_time():
    """Return the current local date and time."""
    return datetime.now().strftime("%d-%m-%Y %I:%M:%S %p")


tools = [
    types.Tool(
        function_declarations=[
            types.FunctionDeclaration(
                name="calculate",
                description="Calculate a mathematical expression.",
                parameters=types.Schema(
                    type="OBJECT",
                    properties={
                        "expression": types.Schema(
                            type="STRING",
                            description="Example: 25 * 4 + 10",
                        )
                    },
                    required=["expression"],
                ),
            ),
            types.FunctionDeclaration(
                name="read_notes",
                description="Read the student's Java notes.",
                parameters=types.Schema(type="OBJECT"),
            ),
            types.FunctionDeclaration(
                name="get_current_time",
                description="Get the current local date and time.",
                parameters=types.Schema(type="OBJECT"),
            ),
        ]
    )
]


def execute_tool(name, args):
    """Execute a known tool and return a safe result plus success status."""
    start_time = time.time()
    args = args if isinstance(args, dict) else {}

    try:
        if name == "calculate":
            result = calculate(args.get("expression"))
        elif name == "read_notes":
            result = read_notes()
        elif name == "get_current_time":
            result = get_current_time()
        else:
            return "Tool is not available.", False
    except Exception:
        logger.warning("Tool execution failed: %s", name)
        return "Tool could not be executed.", False
    finally:
        logger.info("Tool %s completed in %.3fs", name, time.time() - start_time)

    return result, not result.startswith(("Invalid ", "Cannot ", "Tool "))


def get_client(api_key):
    global _client, _client_api_key

    if _client is None or _client_api_key != api_key:
        _client = genai.Client(
            api_key=api_key,
            http_options=types.HttpOptions(timeout=API_TIMEOUT_MS),
        )
        _client_api_key = api_key

    return _client


def _api_error_message(error):
    error_name = type(error).__name__.lower()
    error_text = str(error).lower()
    if "timeout" in error_name or "timeout" in error_text:
        return "The AI service timed out. Please try again."
    if "quota" in error_text or "rate" in error_text:
        return "The AI service is busy. Please try again later."
    if "auth" in error_name or "permission" in error_text or "api key" in error_text:
        return "The AI service is not configured correctly."
    return "The AI service is temporarily unavailable."


def run_agent_details(message, note_context=""):
    total_start_time = time.time()
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return {"answer": "The AI service is not configured.", "tools": []}

    try:
        client = get_client(api_key)
    except Exception as error:
        logger.warning(
            "Gemini client initialization failed: %s",
            type(error).__name__,
        )
        return {"answer": _api_error_message(error), "tools": []}

    contents = [
        types.Content(
            role="user",
            parts=[types.Part.from_text(text=message)],
        )
    ]
    if note_context:
        contents[0].parts.insert(
            0,
            types.Part.from_text(
                text="Use this selected note context first:\n" + note_context
            ),
        )

    tool_events = []
    for iteration in range(MAX_AGENT_ITERATIONS):
        logger.info("Agent iteration %d", iteration + 1)
        try:
            response = client.models.generate_content(
                model=MODEL,
                contents=contents,
                config=types.GenerateContentConfig(
                    system_instruction=SYSTEM_PROMPT,
                    tools=tools,
                    temperature=0.2,
                    max_output_tokens=512,
                ),
            )
        except Exception as error:
            logger.warning("Gemini request failed: %s", type(error).__name__)
            return {"answer": _api_error_message(error), "tools": tool_events}

        if not response.candidates:
            return {"answer": "The AI returned an empty response.", "tools": tool_events}

        contents.append(response.candidates[0].content)
        if not response.function_calls:
            logger.info("Agent completed in %.2fs", time.time() - total_start_time)
            return {
                "answer": response.text or "The AI returned an empty response.",
                "tools": tool_events,
            }

        for call in response.function_calls:
            event = {"name": call.name, "args": call.args or {}}
            result, succeeded = execute_tool(call.name, call.args)
            event["status"] = "completed" if succeeded else "failed"
            tool_events.append(event)
            contents.append(
                types.Content(
                    role="user",
                    parts=[
                        types.Part.from_function_response(
                            name=call.name,
                            response={"result": result},
                        )
                    ],
                )
            )

    return {
        "answer": "I reached the tool-operation limit. Please try a simpler question.",
        "tools": tool_events,
    }


def run_agent(message, note_context=""):
    return run_agent_details(message, note_context)["answer"]


def main():
    print("CodeMentor AI - Java Study Agent")
    print("Type 'quit' to exit.")
    while True:
        message = input("You: ").strip()
        if message.lower() in ["quit", "exit"]:
            print("Agent: Goodbye!")
            break
        if message:
            print(f"\nAgent: {run_agent(message)}\n")


if __name__ == "__main__":
    main()
