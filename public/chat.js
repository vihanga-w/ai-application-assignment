// chat.js

(function () {
  const chatMessagesEl = document.getElementById("chat-messages");
  const typingIndicatorEl = document.getElementById("typing-indicator");
  const userInputEl = document.getElementById("user-input");
  const sendButtonEl = document.getElementById("send-button");

  let socket = null;
  let socketReadyPromise = null;
  let isBusy = false;

  function scrollToBottom() {
    chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight;
  }

  function createMessageElement(role, text) {
    const msgEl = document.createElement("div");
    msgEl.classList.add("message");
    if (role === "user") {
      msgEl.classList.add("user-message");
    } else {
      msgEl.classList.add("assistant-message");
    }

    // Meta
    const metaEl = document.createElement("div");
    metaEl.classList.add("message-meta");

    const nameSpan = document.createElement("span");
    nameSpan.textContent = role === "user" ? "You" : "Fact Checker";

    const dot = document.createElement("div");
    dot.classList.add("meta-dot");

    const sideSpan = document.createElement("span");
    sideSpan.textContent = role === "user" ? "Input" : "Response";

    metaEl.appendChild(nameSpan);
    metaEl.appendChild(dot);
    metaEl.appendChild(sideSpan);

    msgEl.appendChild(metaEl);

    // Content – split by double newline into paragraphs
    const paragraphs = String(text).split(/\n{2,}/);
    paragraphs.forEach((para, idx) => {
      if (!para.trim()) return;
      const p = document.createElement("p");
      p.textContent = para.trim();
      if (idx > 0) p.style.marginTop = "0.35rem";
      msgEl.appendChild(p);
    });

    return msgEl;
  }

  function addMessage(role, text) {
    const msgEl = createMessageElement(role, text);
    chatMessagesEl.appendChild(msgEl);
    scrollToBottom();
    return msgEl;
  }

  function setTypingIndicator(visible, text) {
    if (text) {
      typingIndicatorEl.textContent = text;
    }
    typingIndicatorEl.classList.toggle("visible", visible);
  }

  function setBusyState(busy) {
    isBusy = busy;
    sendButtonEl.disabled = busy;
    userInputEl.disabled = busy;
    setTypingIndicator(busy, busy
      ? "Analyzing information and searching for evidence..."
      : "Analyzing information and searching for evidence..."
    );
  }

  function connectWebSocket() {
    if (socket && socket.readyState === WebSocket.OPEN) {
      return;
    }

    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${protocol}//${window.location.host}/api/chat`;

    socket = new WebSocket(wsUrl);

    socketReadyPromise = new Promise((resolve, reject) => {
      socket.onopen = () => {
        resolve(socket);
      };

      socket.onerror = (err) => {
        console.error("WebSocket error:", err);
        reject(err);
      };
    });

    socket.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (e) {
        console.warn("Non-JSON WebSocket message:", event.data);
        return;
      }

      handleServerMessage(msg);
    };

    socket.onclose = (event) => {
      console.log("WebSocket closed:", event.code, event.reason);
      if (isBusy) {
        setBusyState(false);
        addMessage(
          "assistant",
          "The connection was interrupted while fact-checking. Please try again."
        );
      }
    };
  }

  function ensureSocketOpen() {
    if (!socket || socket.readyState === WebSocket.CLOSED || socket.readyState === WebSocket.CLOSING) {
      connectWebSocket();
    }
    return socketReadyPromise;
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case "status": {
        const stage = msg.stage || "";
        if (stage === "query_generation") {
          setTypingIndicator(true, "Generating search queries...");
        } else if (stage === "research") {
          setTypingIndicator(true, "Searching the web and collecting evidence...");
        } else if (stage === "final_answer") {
          setTypingIndicator(true, "Analysing evidence and writing the final assessment...");
        }
        break;
      }

      case "queries": {
        const queries = msg.data || [];
        if (queries.length > 0) {
          const text =
            "I'll research these queries to verify your claim:\n\n" +
            queries.map((q, i) => `${i + 1}. ${q.query}`).join("\n");
          addMessage("assistant", text);
        }
        break;
      }

      case "progress": {
        const { stage, queryIndex, totalQueries, query } = msg;
        const stageText =
          stage === "search"
            ? "Searching"
            : stage === "page_extracted"
            ? "Extracted page text for"
            : "Working on";
        setTypingIndicator(
          true,
          `${stageText} query ${queryIndex} of ${totalQueries}: "${query}"`
        );
        break;
      }

      case "final": {
        setBusyState(false);
        setTypingIndicator(false);
        const answer = msg.answer || "I wasn't able to generate a response.";
        addMessage("assistant", answer);
        break;
      }

      case "error": {
        setBusyState(false);
        setTypingIndicator(false);
        const message =
          msg.message || "Something went wrong while fact-checking your input.";
        addMessage("assistant", `Error: ${message}`);
        break;
      }

      default:
        console.log("Unknown message type from server:", msg);
    }
  }

  async function sendUserMessage() {
    if (isBusy) return;

    const content = userInputEl.value.trim();
    if (!content) return;

    // Add user message to UI
    addMessage("user", content);
    userInputEl.value = "";
    autoResizeTextarea();

    setBusyState(true);
    setTypingIndicator(true, "Generating search queries...");

    try {
      await ensureSocketOpen();
      const payload = {
        messages: [
          {
            role: "user",
            content,
          },
        ],
      };
      socket.send(JSON.stringify(payload));
    } catch (err) {
      console.error("Failed to send over WebSocket:", err);
      setBusyState(false);
      setTypingIndicator(false);
      addMessage(
        "assistant",
        "I couldn't connect to the server to fact-check your input. Please try again."
      );
    }
  }

  function autoResizeTextarea() {
    userInputEl.style.height = "auto";
    const maxHeight = 120;
    const newHeight = Math.min(userInputEl.scrollHeight, maxHeight);
    userInputEl.style.height = newHeight + "px";
  }

  // Event listeners
  sendButtonEl.addEventListener("click", (e) => {
    e.preventDefault();
    sendUserMessage();
  });

  userInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendUserMessage();
    }
  });

  userInputEl.addEventListener("input", autoResizeTextarea);

  // Initialise
  connectWebSocket();
})();
