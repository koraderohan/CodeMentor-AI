import logging
import os
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory
from flask_cors import CORS
from werkzeug.exceptions import RequestEntityTooLarge

from agent import run_agent_details


logger = logging.getLogger(__name__)
STATIC_FOLDER = Path(__file__).with_name("frontend") / "dist"
MAX_REQUEST_BYTES = 16 * 1024
MAX_MESSAGE_LENGTH = 2000

app = Flask(__name__, static_folder=str(STATIC_FOLDER), static_url_path="")
app.config["MAX_CONTENT_LENGTH"] = MAX_REQUEST_BYTES

cors_origins = [
    origin.strip()
    for origin in os.environ.get("CORS_ORIGINS", "").split(",")
    if origin.strip()
]
if cors_origins:
    CORS(app, resources={r"/api/*": {"origins": cors_origins}})


@app.after_request
def add_security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "no-referrer")
    response.headers.setdefault(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=()",
    )
    response.headers.setdefault(
        "Content-Security-Policy",
        (
            "default-src 'self'; "
            "img-src 'self' https: data:; "
            "style-src 'self' 'unsafe-inline'; "
            "script-src 'self'; "
            "connect-src 'self'; "
            "frame-ancestors 'none'; "
            "base-uri 'self'"
        ),
    )
    return response


@app.errorhandler(RequestEntityTooLarge)
def handle_request_too_large(_error):
    return jsonify({"error": "Request body is too large."}), 413


def parse_json_object():
    if not request.is_json:
        return None, (jsonify({"error": "Request body must be JSON."}), 400)

    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        return None, (jsonify({"error": "Request body must be a JSON object."}), 400)

    return data, None


@app.route("/api/chat", methods=["POST"])
def chat():
    data, error_response = parse_json_object()
    if error_response:
        return error_response

    message = data.get("message")
    if not isinstance(message, str):
        return jsonify({"error": "Message must be a string."}), 400

    message = message.strip()
    if not message:
        return jsonify({"error": "Message is required."}), 400
    if len(message) > MAX_MESSAGE_LENGTH:
        return jsonify({
            "error": (
                f"Message must be {MAX_MESSAGE_LENGTH} characters or fewer."
            )
        }), 413

    try:
        details = run_agent_details(message)
    except Exception as error:
        logger.warning(
            "Unexpected chat request failure: %s",
            type(error).__name__,
        )
        return jsonify({"error": "The AI service is temporarily unavailable."}), 502

    if not isinstance(details, dict) or not isinstance(details.get("answer"), str):
        logger.error("Agent returned an invalid response")
        return jsonify({"error": "The AI service returned an invalid response."}), 502

    return jsonify({
        "answer": details["answer"],
        "tools": details.get("tools", []),
    }), 200


@app.route("/api/feedback", methods=["POST"])
def feedback():
    data, error_response = parse_json_object()
    if error_response:
        return error_response
    if data.get("rating") not in {"helpful", "not_helpful"}:
        return jsonify({"error": "Rating must be helpful or not_helpful."}), 400
    return jsonify({"saved": True})


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "CodeMentor AI backend is running"})


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def frontend(path):
    static_root = STATIC_FOLDER.resolve()
    requested_file = (static_root / path).resolve()
    if (
        path
        and static_root in requested_file.parents
        and requested_file.is_file()
    ):
        return send_from_directory(str(static_root), path)
    return send_from_directory(str(static_root), "index.html")


if __name__ == "__main__":
    app.run(
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "5000")),
        debug=False,
    )
