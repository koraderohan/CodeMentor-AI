import { useEffect, useId, useRef, useState } from "react";
import axios from "axios";
import mermaid from "mermaid";
import ReactMarkdown from "react-markdown";
import { normalizeMermaidCode } from "./mermaidUtils";

// ---------- MERMAID CONFIGURATION ----------

mermaid.initialize({
  startOnLoad: false,
  suppressErrorRendering: true,
  securityLevel: "strict",
  theme: "base",
  themeVariables: {
    background: "#F4F1EA",
    primaryColor: "#F4F1EA",
    primaryTextColor: "#1C1C1A",
    primaryBorderColor: "#B5472B",
    lineColor: "#1C1C1A",
  },
});


// ---------- MERMAID DIAGRAM ----------

const loggedMermaidFailures = new Set();

function MermaidDiagram({ chart }) {
  const containerRef = useRef(null);
  const [failedChart, setFailedChart] = useState(null);
  const diagramId = useId().replace(/:/g, "");
  const normalizedChart = normalizeMermaidCode(chart);
  const error = failedChart === normalizedChart;

  useEffect(() => {
    let active = true;

    mermaid
      .render(`diagram-${diagramId}`, normalizedChart)
      .then(({ svg, bindFunctions }) => {
        if (!active || !containerRef.current) return;

        setFailedChart(null);
        containerRef.current.innerHTML = svg;
        bindFunctions?.(containerRef.current);
      })
      .catch((renderError) => {
        if (active) setFailedChart(normalizedChart);

        if (!loggedMermaidFailures.has(normalizedChart)) {
          loggedMermaidFailures.add(normalizedChart);
          console.error("Mermaid rendering failed.", renderError);
        }

        if (active && containerRef.current) {
          containerRef.current.replaceChildren();
        }
      });

    return () => {
      active = false;
    };
  }, [normalizedChart, diagramId]);

  return (
    <div className="mermaid-diagram" ref={containerRef}>
      {error && (
        <p role="alert">
          This Mermaid diagram could not be rendered.
        </p>
      )}
    </div>
  );
}


function isSafeUrl(value) {
  if (!value || typeof value !== "string") return false;

  try {
    const url = new URL(value, window.location.origin);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}


// ---------- MARKDOWN IMAGE ----------

function MarkdownImage({ alt = "", src = "" }) {
  const [visible, setVisible] = useState(true);

  if (!visible || !isSafeUrl(src)) return null;

  return (
    <figure className="markdown-image">
      <img
        src={src}
        alt={alt}
        onError={() => setVisible(false)}
      />

      {alt && <figcaption>{alt}</figcaption>}
    </figure>
  );
}


// ---------- MARKDOWN CONTENT ----------

function MarkdownContent({ content }) {
  return (
    <ReactMarkdown
      components={{
        a: ({ href, children }) =>
          isSafeUrl(href) ? (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ) : (
            <span>{children}</span>
          ),

        img: ({ alt, src }) => (
          <MarkdownImage alt={alt} src={src} />
        ),

        code: ({ children, className }) => {
          const language = className?.replace("language-", "");

          if (language === "mermaid") {
            return (
              <MermaidDiagram
                chart={String(children)}
              />
            );
          }

          return (
            <code className={className}>
              {children}
            </code>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
}


const PROGRESS_STORAGE_KEY = "study-buddy-progress";
const DEFAULT_PROGRESS = {
  questions: 0,
  quizzes: 0,
  helpful: 0,
};

function normalizeProgress(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_PROGRESS;
  }

  return Object.keys(DEFAULT_PROGRESS).reduce(
    (progress, key) => {
      const count = value[key];

      if (
        Number.isFinite(count) &&
        count >= 0
      ) {
        progress[key] = Math.floor(count);
      }

      return progress;
    },
    { ...DEFAULT_PROGRESS }
  );
}

function loadProgress() {
  try {
    const saved = localStorage.getItem(PROGRESS_STORAGE_KEY);
    return normalizeProgress(saved ? JSON.parse(saved) : null);
  } catch {
    return { ...DEFAULT_PROGRESS };
  }
}


// ---------- MAIN APP ----------

function App() {
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState([]);
  const [loading, setLoading] = useState(false);

  const [mode, setMode] = useState("chat");

  const [lastUserMessage, setLastUserMessage] = useState("");

  const [feedback, setFeedback] = useState({});
  const feedbackStatusRef = useRef({});
  const [progress, setProgress] = useState(loadProgress);

  const abortControllerRef = useRef(null);

  // ---------- STUDY MODES ----------

  const modeInstructions = {
    chat: "",

    quiz:
      "Ask me one question at a time and wait for my answer. Start a quick quiz on: ",

    flashcards:
      "Create five concise flashcards about: ",

    plan:
      "Create a practical study plan for: ",
  };


  // ---------- PROGRESS ----------

  const updateProgress = (changes) => {
    setProgress((current) => {
      const nextChanges =
        typeof changes === "function"
          ? changes(current)
          : changes;
      const next = {
        ...current,
        ...nextChanges,
      };

      try {
        localStorage.setItem(PROGRESS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Progress remains available for the current session.
      }

      return next;
    });
  };


  // ---------- SEND MESSAGE ----------

  const sendMessage = async (providedMessage = message) => {
    if (!providedMessage.trim() || abortControllerRef.current) {
      return;
    }

    const userMessage = providedMessage.trim();

    const requestMessage =
      mode === "chat"
        ? userMessage
        : `${modeInstructions[mode]}${userMessage}`;

    setMessages((prev) => [
      ...prev,
      {
        role: "user",
        text: userMessage,
      },
    ]);

    setMessage("");
    setLoading(true);
    setLastUserMessage(userMessage);

    const controller = new AbortController();

    abortControllerRef.current = controller;

    try {
      const response = await axios.post(
        "/api/chat",
        {
          message: requestMessage,
        },
        {
          signal: controller.signal,

          timeout: 35000,
        }
      );

      if (!response.data || !response.data.answer) {
        throw new Error("Backend returned an empty response.");
      }

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          text: response.data.answer,
          tools: response.data.tools || [],
        },
      ]);

      updateProgress((current) => ({
        questions: current.questions + 1,
      }));

    } catch (error) {
      if (!controller.signal.aborted) {
        let errorMessage =
          "Something went wrong. Please try again.";

        if (error.code === "ECONNABORTED") {
          errorMessage =
            "The AI took too long to respond. Please try again.";
        } else if (error.response?.data?.error) {
          errorMessage = error.response.data.error;
        } else if (error.response?.status === 404) {
          errorMessage =
            "Chat API endpoint not found. Check your Flask backend.";
        } else if (error.response?.status >= 500) {
          errorMessage =
            "Backend server error. Check the Flask terminal for details.";
        } else if (
          error.code === "ERR_NETWORK" ||
          !error.response
        ) {
          errorMessage =
            "Cannot connect to Flask backend. Make sure it is running on port 5000.";
        }

        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            text: errorMessage,
          },
        ]);
      }

    } finally {
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
        setLoading(false);
      }
    }
  };


  // ---------- STOP GENERATION ----------

  const stopMessage = () => {
    abortControllerRef.current?.abort();
  };


  // ---------- CLEAR CHAT ----------

  const clearChat = () => {
    setMessages([]);
  };


  // ---------- RETRY ----------

  const retryLastMessage = () => {
    if (lastUserMessage && !loading) {
      sendMessage(lastUserMessage);
    }
  };


  // ---------- COPY MESSAGE ----------

  const copyText = async (text, index) => {
    try {
      await navigator.clipboard.writeText(text);

      setFeedback((current) => ({
        ...current,
        [`copy-${index}`]: "Copied",
      }));

      setTimeout(() => {
        setFeedback((current) => ({
          ...current,
          [`copy-${index}`]: "",
        }));
      }, 1500);

    } catch {
      setFeedback((current) => ({
        ...current,
        [`copy-${index}`]: "Copy unavailable",
      }));
    }
  };


  // ---------- FEEDBACK ----------

  const sendFeedback = async (index, rating) => {
    const currentStatus = feedbackStatusRef.current[index];

    if (currentStatus) {
      return;
    }

    feedbackStatusRef.current[index] = "pending";

    try {
      await axios.post(
        "/api/feedback",
        {
          rating,
        },
        {
          timeout: 10000,
        }
      );

      setFeedback((current) => ({
        ...current,
        [index]: rating,
      }));

      if (rating === "helpful") {
        updateProgress((current) => ({
          helpful: current.helpful + 1,
        }));
      }

      feedbackStatusRef.current[index] = rating;
    } catch {
      delete feedbackStatusRef.current[index];

      setFeedback((current) => ({
        ...current,
        [index]: "Feedback unavailable",
      }));
    }
  };


  // ---------- EXPORT CHAT ----------

  const exportChat = () => {
    const markdown = messages
      .map(
        (item) =>
          `**${item.role === "user" ? "You" : "Agent"}**\n\n${item.text}`
      )
      .join("\n\n---\n\n");

    const blob = new Blob(
      [markdown],
      {
        type: "text/markdown",
      }
    );

    const url = URL.createObjectURL(blob);

    const link = document.createElement("a");

    link.href = url;
    link.download = "codementor-ai-chat.md";

    link.click();

    URL.revokeObjectURL(url);
  };


  // ---------- KEYBOARD HANDLER ----------

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };


  const handleModeChange = (nextMode) => {
    if (nextMode === mode) {
      return;
    }

    if (nextMode === "quiz") {
      updateProgress((current) => ({
        quizzes: current.quizzes + 1,
      }));
    }

    setMode(nextMode);
  };


  // ---------- COMPONENT CLEANUP ----------

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);


  // ---------- UI ----------

  return (
    <div className="app">

      {/* SIDEBAR */}

      <aside className="sidebar">

        <header className="project-header">

          <p className="project-kicker">
            STUDY BUDDY
          </p>

          <h1>
            Java questions,
            <br />
            made clearer.
          </h1>

          <p className="project-description">
            A practical place to work through Java questions,
            one problem at a time.
          </p>

        </header>


        {/* AVAILABLE TOOLS */}

        <section
          className="tools"
          aria-labelledby="tools-heading"
        >

          <h2 id="tools-heading">
            Available tools
          </h2>

          <ul>
            <li>Explain Java concepts</li>
            <li>Work through calculations</li>
            <li>Review code examples</li>
            <li>Prepare for exams</li>
          </ul>

        </section>


        {/* STUDY MODES */}

        <section
          className="study-panel"
          aria-labelledby="study-heading"
        >

          <h2 id="study-heading">
            Study modes
          </h2>

          <div className="mode-list">

            {Object.keys(modeInstructions).map((option) => (

              <button
                className={
                  mode === option ? "selected" : ""
                }
                key={option}
                onClick={() => handleModeChange(option)}
                disabled={loading}
              >
                {option}
              </button>

            ))}

          </div>

        </section>


        {/* PROGRESS */}

        <section
          className="progress-panel"
          aria-label="Study progress"
        >

          <p>
            {progress.questions} questions ·{" "}
            {progress.quizzes} quizzes
          </p>

          <p>
            {progress.helpful} helpful answers
          </p>

        </section>


      </aside>


      {/* MAIN WORKSPACE */}

      <main className="workspace">

        {/* HEADER */}

        <header className="chat-header">

          <div>

            <p className="chat-kicker">
              CONVERSATION
            </p>

            <h2>
              Ask a question
            </h2>

          </div>


          <div className="header-actions">

            <button
              onClick={exportChat}
              disabled={!messages.length}
            >
              Export
            </button>

            <button
              onClick={clearChat}
              disabled={!messages.length}
            >
              Clear
            </button>

            <span className="agent-status">
              {loading ? "Working" : "Ready"}
            </span>

          </div>

        </header>


        {/* CHAT CONTAINER */}

        <section
          className="chat-container"
          aria-live="polite"
        >

          {messages.length === 0 && (

            <div className="welcome">

              <p className="welcome-label">
                Start here
              </p>

              <p>
                Try asking: “What is the difference between
                an interface and an abstract class?”
              </p>

            </div>

          )}


          {/* CHAT MESSAGES */}

          {messages.map((msg, index) => (

            <div
              key={index}
              className={`message ${msg.role}`}
            >

              <strong>
                {msg.role === "user" ? "You" : "Agent"}
              </strong>


              <div className="message-content">

                <MarkdownContent content={msg.text} />

              </div>


              {/* TOOL EVENTS */}

              {msg.tools?.map((tool, toolIndex) => (

                <div
                  className="tool-event"
                  key={`${tool.name}-${toolIndex}`}
                >
                  → {tool.name}(
                  {JSON.stringify(tool.args || {})}
                  )
                </div>

              ))}


              {/* MESSAGE ACTIONS */}

              {msg.role === "assistant" && (

                <div className="message-actions">

                  <button
                    onClick={() => copyText(msg.text, index)}
                  >
                    {feedback[`copy-${index}`] || "Copy"}
                  </button>

                  <button
                    onClick={() =>
                      sendFeedback(index, "helpful")
                    }
                  >
                    Helpful
                  </button>

                  <button
                    onClick={() =>
                      sendFeedback(index, "not_helpful")
                    }
                  >
                    Not helpful
                  </button>

                  {feedback[index] && (
                    <span>{feedback[index]}</span>
                  )}

                </div>

              )}

            </div>

          ))}


          {/* LOADING */}

          {loading && (

            <div className="message assistant">

              <strong>
                Agent
              </strong>

              <div className="message-content">

                <MarkdownContent content="Thinking..." />

              </div>

              <button
                className="stop-button"
                onClick={stopMessage}
              >
                Stop
              </button>

            </div>

          )}


          {/* RETRY */}

          {!loading && messages.length > 0 && (

            <button
              className="retry-button"
              onClick={retryLastMessage}
            >
              Try again
            </button>

          )}

        </section>


        {/* MESSAGE INPUT */}

        <div className="composer-wrap">

          <div className="input-area">

            <textarea
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Write your Java question..."
              rows="2"
              maxLength="2000"
              aria-label="Ask a Java question"
            />

            <button
              onClick={() => sendMessage()}
              disabled={loading || !message.trim()}
            >
              {loading ? "Sending..." : "Send"}
            </button>

          </div>


          <p className="composer-hint">
            Enter to send / Shift + Enter for a new line
          </p>

        </div>

      </main>

    </div>
  );
}

export default App;
