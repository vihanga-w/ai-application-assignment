/**
 * Fact-checking chat backend using Cloudflare Workers AI + SerpAPI.
 *
 * - Serves static assets for the frontend
 * - Exposes a REST `/api/chat` endpoint
 * - Exposes a WebSocket `/api/chat` endpoint with progress events
 */

import { Env, ChatMessage } from "./types";

// Workers AI model
// https://developers.cloudflare.com/workers-ai/models/
const MODEL_ID = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

// TODO: move this to environment variables in production.
const SERPAPI_API_KEY =
    "727ca825eca8b1dac43a8d54efe7d62dc97fa8fdd2be16ab19285ef1fbfbbb9a";

// How many results per query to extract page text from
const MAX_RESULTS_PER_QUERY = 3;

const SYSTEM_PROMPT = `
You are a focused fact-checking query generator. Your task is to analyse the user's input and output the 4–6 most effective web search queries needed to verify the information.

Rules:
 - Output only 4–6 search queries.
 - Never include explanations or additional text.
 - Queries should be actionable, precise, and designed for verification (not summarisation).
 - Longer queries are allowed when needed for clarity.
 - Queries should be suitable for use in a search engine.
 - Queries may be phrased as questions if appropriate.
 - Use JSON only, no extra text.
 - Prefer including resources such as Reddit and Stack Overflow for community insight where relevant.

Do not quote or restate the original user input unless necessary for the query.

You will then be provided with web search results for each query to assist in fact-checking. You must use these results to inform your final response assessing the accuracy of their input.
Do not refer to the user as "the user" in your final response; speak directly in the second person ("you").

Output format:
[
  {
    "query": "<query1>",
    "description": "<short description 1>"
  },
  {
    "query": "<query2>",
    "description": "<short description 2>"
  }
]
`;

export default {
    async fetch(
        request: Request,
        env: Env,
        ctx: ExecutionContext,
    ): Promise<Response> {
        const url = new URL(request.url);

        // Serve frontend / static files by default
        if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
            return env.ASSETS.fetch(request);
        }

        if (url.pathname === "/api/chat") {
            const upgradeHeader = (request.headers.get("Upgrade") || "").toLowerCase();

            // WebSocket endpoint: GET + Upgrade: websocket
            if (request.method === "GET" && upgradeHeader === "websocket") {
                const pair = new WebSocketPair();
                const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

                handleWebSocketChat(server, env, ctx);

                return new Response(null, {
                    status: 101,
                    webSocket: client,
                });
            }

            // HTTP POST chat endpoint
            if (request.method === "POST") {
                return handleChatRequest(request, env);
            }

            return new Response("Method not allowed", { status: 405 });
        }

        return new Response("Not found", { status: 404 });
    },
} satisfies ExportedHandler<Env>;

/**
 * Basic SerpAPI search wrapper.
 */
async function serpApiSearch(query: string) {
    const params = new URLSearchParams({
        engine: "google",
        q: query,
        google_domain: "google.com",
        gl: "gb",
        hl: "en",
        async: "false",
        api_key: SERPAPI_API_KEY,
    });

    const url = `https://serpapi.com/search.json?${params.toString()}`;

    try {
        const res = await fetch(url);

        if (!res.ok) {
            throw new Error(`SerpAPI error: ${res.status} ${res.statusText}`);
        }

        return await res.json();
    } catch (err) {
        console.error("SerpAPI request failed:", err);
        return null;
    }
}

/**
 * Rough HTML --> text converter with some basic cleaning.
 */
function stripHTML(
    html: string,
    {
        maxLength = 8000,
        minLineLength = 40,
    }: { maxLength?: number; minLineLength?: number } = {},
): string {
    if (!html) return "";

    let text = html;

    // 1. Remove scripts, styles, head, comments, etc.
    text = text
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
        .replace(/<head[\s\S]*?<\/head>/gi, "")
        .replace(/<!--[\s\S]*?-->/g, "");

    // 2. Turn block-level tags into newlines so structure isn't completely lost
    const blockTags = [
        "p",
        "div",
        "article",
        "section",
        "header",
        "footer",
        "main",
        "aside",
        "nav",
        "li",
        "ul",
        "ol",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "tr",
        "td",
        "th",
        "blockquote",
        "pre",
        "br",
    ];

    const blockRegex = new RegExp(`<\\/?(?:${blockTags.join("|")})[^>]*>`, "gi");
    text = text.replace(blockRegex, "\n");

    // 3. Strip any remaining tags
    text = text.replace(/<[^>]+>/g, " ");

    // 4. Decode a few common entities (good enough for this use-case)
    const entityMap: Record<string, string> = {
        "&nbsp;": " ",
        "&amp;": "&",
        "&lt;": "<",
        "&gt;": ">",
        "&quot;": '"',
        "&#39;": "'",
    };

    text = text.replace(/&[a-zA-Z#0-9]+;/g, (entity) => {
        if (entityMap[entity]) return entityMap[entity];

        const numericMatch = entity.match(/^&#(\d+);$/);
        if (numericMatch) {
            const code = Number(numericMatch[1]);
            if (!Number.isNaN(code)) {
                return String.fromCharCode(code);
            }
        }

        return " ";
    });

    // 5. Normalise whitespace and line breaks
    text = text.replace(/\r\n/g, "\n");
    text = text.replace(/[ \t]+/g, " ");
    text = text.replace(/\n{3,}/g, "\n\n");

    // 6. Split into lines and drop very short / noisy ones
    const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length >= minLineLength && !/^\W+$/.test(line));

    text = lines.join("\n\n").trim();

    // 7. Truncate to avoid huge token usage
    if (text.length > maxLength) {
        text = text.slice(0, maxLength);
    }

    return text;
}

/**
 * WebSocket lifecycle for chat.
 */
function handleWebSocketChat(ws: WebSocket, env: Env, ctx: ExecutionContext) {
    ws.accept();

    ws.addEventListener("message", (event) => {
        const data =
            typeof event.data === "string"
                ? event.data
                : (event.data as ArrayBuffer | Uint8Array);

        const text =
            typeof data === "string"
                ? data
                : new TextDecoder().decode(data as ArrayBuffer);

        ctx.waitUntil(processChatOverWebSocket(ws, text, env));
    });

    ws.addEventListener("close", () => {
        // Optionally log or clean up
    });

    ws.addEventListener("error", (err) => {
        console.error("WebSocket error:", err);
    });
}

/**
 * Core WebSocket chat flow: generate queries --> search --> final answer.
 */
async function processChatOverWebSocket(
    ws: WebSocket,
    raw: string,
    env: Env,
) {
    let payload: { messages?: ChatMessage[] };

    try {
        payload = JSON.parse(raw);
    } catch {
        ws.send(
            JSON.stringify({ type: "error", message: "Invalid JSON payload" }),
        );
        ws.close(1003, "Invalid JSON");
        return;
    }

    const messages = payload.messages ?? [];

    if (!Array.isArray(messages) || messages.length === 0) {
        ws.send(
            JSON.stringify({
                type: "error",
                message: "Missing or empty 'messages' array",
            }),
        );
        return;
    }

    // Ensure we have the system prompt
    if (!messages.some((msg) => msg.role === "system")) {
        messages.unshift({ role: "system", content: SYSTEM_PROMPT });
    }

    try {
        ws.send(
            JSON.stringify({
                type: "status",
                stage: "query_generation",
                message: "Generating fact-checking search queries...",
            }),
        );

        // 1) First LLM call: generate search queries
        const queryResponse = (await env.AI.run(MODEL_ID, {
            messages,
            max_tokens: 1024,
        })) as {
            response: {
                query: string;
                description: string;
            }[];
        };

        const parsedQueries = queryResponse.response || [];

        ws.send(
            JSON.stringify({
                type: "queries",
                data: parsedQueries,
            }),
        );

        // 2) For each query: SerpAPI search + AI overview HTML extraction
        ws.send(
            JSON.stringify({
                type: "status",
                stage: "research",
                message: "Running web searches and collecting evidence...",
            }),
        );

        const rawHtmlContents: string[] = [];
        const searchData: any[] = [];

        let index = 0;
        for (const item of parsedQueries) {
            index++;

            ws.send(
                JSON.stringify({
                    type: "progress",
                    stage: "search",
                    queryIndex: index,
                    totalQueries: parsedQueries.length,
                    query: item.query,
                }),
            );

            const serp = (await serpApiSearch(item.query)) as any;
            const aiOverviewLink = serp?.ai_overview?.serpapi_link || null;

            if (!aiOverviewLink) {
                console.warn(`No AI overview link found for query: ${item.query}`);
            } else {
                try {
                    const overviewRes = await fetch(
                        `${aiOverviewLink}&api_key=${SERPAPI_API_KEY}`,
                    );
                    const overviewJson = (await overviewRes.json()) as {
                        search_metadata?: {
                            raw_html_file?: string;
                        };
                    };

                    if (overviewJson.search_metadata?.raw_html_file) {
                        const pageRes = await fetch(
                            overviewJson.search_metadata.raw_html_file,
                        );
                        const html = await pageRes.text();
                        const text = stripHTML(html);

                        rawHtmlContents.push(
                            [
                                "===== PAGE BREAK =====",
                                `Query: ${item.query}`,
                                `Query description: ${item.description}`,
                                "",
                                "Results:",
                                text,
                            ].join("\n"),
                        );

                        ws.send(
                            JSON.stringify({
                                type: "progress",
                                stage: "page_extracted",
                                queryIndex: index,
                                totalQueries: parsedQueries.length,
                                query: item.query,
                            }),
                        );
                    }
                } catch (err) {
                    console.error("Failed to fetch or process raw HTML file:", err);
                }
            }

            const topResults = getTopResultSummariesFromSerp(
                serp,
                MAX_RESULTS_PER_QUERY,
            );

            searchData.push({
                query: item.query,
                description: item.description,
                serpSummary: topResults,
            });
        }

        const research = rawHtmlContents.join("\n\n");

        // 3) Second LLM call: final fact-checking answer
        ws.send(
            JSON.stringify({
                type: "status",
                stage: "final_answer",
                message:
                    "Analysing collected evidence and composing the final answer...",
            }),
        );

        const finalCompletion = (await env.AI.run(MODEL_ID, {
            messages: [
                ...messages,
                {
                    role: "system",
                    content: `Using the following extracted web page text, provide a detailed and well-referenced answer to the original query, stating how accurate the user's input is based on your research. Cite specific sources from the provided data to support your response.

Extracted Web Page Text:
${research}
`,
                },
            ],
            max_tokens: 1024,
        })) as {
            response: string;
        };

        ws.send(
            JSON.stringify({
                type: "final",
                answer: finalCompletion.response,
                searchData,
            }),
        );
    } catch (err) {
        console.error("Error in WebSocket flow:", err);
        ws.send(
            JSON.stringify({
                type: "error",
                message: "Internal error during fact-checking pipeline",
            }),
        );
        ws.close(1011, "Internal error");
    }
}

/**
 * Pulls top organic results from a SerpAPI response.
 */
function getTopResultSummariesFromSerp(serp: any, limit: number) {
    if (!serp || !Array.isArray(serp.organic_results)) {
        return [];
    }

    return serp.organic_results.slice(0, limit).map((r: any) => ({
        url: r.link,
        cachedUrl: r.cached_page_link || null,
        title: r.title,
        snippet: r.snippet,
        html: r.html || null,
    }));
}

/**
 * HTTP chat handler (non-WebSocket).
 */
async function handleChatRequest(
    request: Request,
    env: Env,
): Promise<Response> {
    try {
        const rawHtmlContents: string[] = [];

        const { messages = [] } = (await request.json()) as {
            messages: ChatMessage[];
        };

        // Ensure system prompt is present
        if (!messages.some((msg) => msg.role === "system")) {
            messages.unshift({ role: "system", content: SYSTEM_PROMPT });
        }

        // First call: generate queries
        const initialResponse = await env.AI.run(
            MODEL_ID,
            {
                messages,
                max_tokens: 1024,
            },
            {
                returnRawResponse: true,
            },
        );

        const initialJson = (await initialResponse.json()) as {
            response: {
                query: string;
                description: string;
            }[];
            tool_calls?: Array<{
                tool: string;
                input: string;
            }>;
            usage: {
                prompt_tokens: number;
                completion_tokens: number;
                total_tokens: number;
            };
        };

        console.log("Generated Queries:", initialJson.response);

        const searchData: any[] = [];

        // For each generated query: SerpAPI + extract text from AI overview
        for (const item of initialJson.response) {
            const serp = (await serpApiSearch(item.query)) as any;
            const aiOverviewLink = serp?.ai_overview?.serpapi_link || null;

            if (!aiOverviewLink) {
                console.warn(`No AI overview link found for query: ${item.query}`);
            } else {
                try {
                    const overviewRes = await fetch(
                        `${aiOverviewLink}&api_key=${SERPAPI_API_KEY}`,
                    );
                    const overviewJson = (await overviewRes.json()) as {
                        search_metadata?: { raw_html_file?: string };
                    };

                    if (overviewJson.search_metadata?.raw_html_file) {
                        const pageRes = await fetch(
                            overviewJson.search_metadata.raw_html_file,
                        );
                        const html = await pageRes.text();
                        const text = stripHTML(html);

                        rawHtmlContents.push(
                            [
                                "===== PAGE BREAK =====",
                                `Query: ${item.query}`,
                                `Query description: ${item.description}`,
                                "",
                                "Results:",
                                text,
                            ].join("\n"),
                        );
                    }
                } catch (err) {
                    console.error("Failed to fetch or process raw HTML file:", err);
                }
            }

            const topResults = getTopResultSummariesFromSerp(
                serp,
                MAX_RESULTS_PER_QUERY,
            );

            searchData.push({
                query: item.query,
                description: item.description,
                serpSummary: topResults,
            });
        }

        const research = rawHtmlContents.join("\n\n");

        // Second call: answer using the collected research
        const researchedResponse = await env.AI.run(
            MODEL_ID,
            {
                messages: [
                    ...messages,
                    {
                        role: "system",
                        content: `Using the following extracted web page text, provide a detailed and well-referenced answer to the user's original query stating how accurate the user input is based on your research. Cite specific sources from the provided data to support your response.

Extracted Web Page Text:
${research}
`,
                    },
                ],
                max_tokens: 1024,
            },
            {
                returnRawResponse: true,
            },
        );

        // We just stream through whatever the model returns here
        return researchedResponse;
    } catch (error) {
        console.error("Error processing chat request:", error);
        return new Response(
            JSON.stringify({ error: "Failed to process request" }),
            {
                status: 500,
                headers: { "content-type": "application/json" },
            },
        );
    }
}