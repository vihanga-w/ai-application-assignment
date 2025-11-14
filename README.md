# LLM Fact-Checking Chat App

This project is a fact-checking–focused chat application built on top of **Cloudflare Workers AI** and **SerpAPI**.  
Instead of just answering questions, it:

1. Generates targeted web search queries.
2. Pulls in live search results (including Google AI Overview pages via SerpAPI).
3. Extracts and cleans page content.
4. Uses an LLM to analyse the evidence and tell you how accurate the original statement is.

It ships with:

- A Cloudflare Worker backend (WebSocket + HTTP)
- A simple browser-based chat UI
- Real-time progress updates while research is running

[Try it out](https://ai-application-assignment.workerscosmos.workers.dev/)

> ⚠️ This chatbot is targetted towards **fact-checking** and **research-style responses**, not generic chat.

---

## Demo / What It Does

This project is a **fact-checking chat interface** with:

- Automatic generation of 4–6 search queries from user input
- Live web search via SerpAPI (including Google AI Overview HTML)
- HTML --> text extraction and cleanup
- Second-pass LLM call that reads the collected evidence and evaluates the accuracy of the original statement
- WebSocket-based status + progress messages (e.g. query generation, search, page extraction, final answer)

The frontend provides:

- A simple chat box
- Streaming / incremental updates from the backend
- Client-side chat history

---

## Features

- Fact-checking–oriented chat flow
- WebSocket-based pipeline with granular status events
- HTTP `/api/chat` endpoint for non-WebSocket usage
- Powered by Cloudflare Workers AI LLMs
- Deep integration with SerpAPI (Google search + AI overview pages)
- Opinionated system prompt for query generation
- Responsive UI (works on mobile and desktop)
- Built with TypeScript and Cloudflare Workers

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) **v20 or newer**
- A [Cloudflare](https://dash.cloudflare.com/) account with **Workers** and **Workers AI** enabled
- A [SerpAPI](https://serpapi.com/) API key

### Note
There is a SerpAPI key included, it is recommended to change this if you choose to clone the project as it is on the free tier.
